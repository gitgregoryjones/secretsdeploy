const { execSync } = require('child_process');
const fs = require('fs')
const core = require('@actions/core');
var path = require('path');


let AWS_ACCESS_KEY_ID = core.getInput('AWS_ACCESS_KEY_ID', { required: false });
let AWS_SECRET_ACCESS_KEY = core.getInput('AWS_SECRET_ACCESS_KEY', { required: false });
let stack_name = core.getInput('project_name', { required: false });
const slackHookUrl = core.getInput('SLACK_HOOK_URL');

var stage = core.getInput('stage',{required: true});

const globalRegion = core.getInput('GLOBAL_REGION') || 'us-east-1';

const regionString = core.getInput('region') || 'us-east-2';

const credentials_json = core.getInput('CREDENTIALS_JSON',{required:true});

const regions = regionString.split(",");


let AWS_DEFAULT_REGION = regions[0];


var myApp = path.dirname(require.main.filename);
if(myApp.indexOf("/") > -1){
    myApp = myApp.substring(myApp.lastIndexOf("/")+1);
}

console.log(`stack name is: ${stack_name}`)
if(stack_name.length == 0){
    stack_name = myApp;
}

console.log(`AWS stack prefix is ${stack_name}`);

function run(cmd, options = {}) {
    if (!options.hide) {
        console.log(`$ ${cmd}`);
    }

    if(options.region){
        AWS_DEFAULT_REGION = options.region;
    }

    return execSync(cmd, {
        shell: '/bin/bash',
        encoding: 'utf-8',
        stdio: 'inherit',
        env: {
            ...process.env,
            AWS_ACCESS_KEY_ID,
            AWS_SECRET_ACCESS_KEY,
            AWS_DEFAULT_REGION
        },
    });
}


console.log(`Trying to determine if we should normalize ${stage}`);

var info_branch = stage;

let extension = ".nonprod";

branch = stage;

if(stage.startsWith("QAv") || stage == 'qa'){
    
    console.log(`Converting Git Repo Branch [${branch}] to deployment location [qa]`);
    branch = "qa";

    stage = "qa";

} else if(stage.startsWith("staging")){

    console.log(`Converting Git Repo Branch [${branch}] to deployment location [staging]`);

    branch = "staging";
    stage = "staging";

} else if(stage == 'master' || stage == 'main'){
    console.log("Master branch gets deployed to production cluster");
    stage = 'production';
    extension = "";
}  else {
    console.log("Defaulting to development branch");
    stage = "development";
    branch = "development";
}

console.log(`Credentials json is ${credentials_json}`);

let credentials = {};

if(credentials_json != null){
    try {
        console.log(`Inspecting credentials for stage ${stage}`);
        credentials = JSON.parse(credentials_json);
        if(!credentials.hasOwnProperty(stage)){
            throw(`Missing credentials for environment ${stage}`);
       
        } else {
            let account = credentials[stage];
            AWS_ACCESS_KEY_ID = account.AWS_ACCESS_KEY_ID;
            AWS_SECRET_ACCESS_KEY = account.AWS_SECRET_ACCESS_KEY;
            console.log(`Found Account`)
            console.log(account.AWS_ACCESS_KEY_ID);
        }
    }catch(err){
        console.log(err)
        throw(`AWS Credentials must be in the format {"${stage}":{"AWS_ACCESS_KEY_ID":"iam-id","AWS_SECRET_ACCESS_KEY":"iam-access-key"},"development":{"AWS_ACCESS_KEY_ID":"iam-id","AWS_SECRET_ACCESS_KEY":"iam-access-key"}}`)
        
    }
}

//Does override docker file exist.  If not default to regular
try {
   console.log(`Looking for docker override file Dockerile${extension}`); 
  if (fs.existsSync(`Dockerfile${extension}`)) {
    console.log(`Will build docker image using file Dockerile${extension}`);
    //file exists
  } else {
    console.error(`Dockerile${extension} does not exist...defaulting to regular Dockerile`);
    extension = "";
  }
} catch(err) {
  console.error(err);
}



let repoString = `${stage}-${stack_name}-repo`;

console.log(`Stage is ${branch} and Dockerile is Dockerfile${extension}`);

console.log("-Building Dockerfile")

console.log(`Building ${info_branch} ->  ${stage}-${stack_name}-service...this may take a while`);


 if(slackHookUrl != "" && slackHookUrl != undefined){

            run(`curl -X POST ${slackHookUrl} -d 'payload={"text": "Building ${info_branch} ->  ${stage}-${stack_name}-service...this may take a while"}'`,{hide:true});
 }


run(`docker build -f Dockerfile${extension} -t "${repoString}" . --build-arg environment=${branch}`);

console.log("AWS GET Account, Login And Upload To ECR");



console.log(regions);




regions.forEach(function(region){

    region = region.trim();

    let serviceFound = false;
   
    try { 
        const sdString = run(`aws ecs describe-services --cluster "${stage}-${stack_name}-cluster"   --service "${stage}-${stack_name}-service"`,{region:region});
        
        serviceDefinitionTest = JSON.parse(sdString);

        if(serviceDefinitionTest.services.length > 0){
            serviceFound = true;
            if(slackHookUrl != "" && slackHookUrl != undefined){

                run(`curl -X POST ${slackHookUrl} -d 'payload={"text": "Deploying ${stage}-${stack_name}-service in region ${region}..."}'`,{hide:true});
            }
        }

    }catch(err){
      if(slackHookUrl != "" && slackHookUrl != undefined){

            run(`curl -X POST ${slackHookUrl} -d 'payload={"text": "Deploying ${stage}-${stack_name}-service in region ${region}..."}'`,{hide:true});
        }  
    }

    try {
        
        if(serviceFound){


            console.log(`GTagging and Pushing image to ${region}`);


            //run(`oldpwd=$(aws ecr get-login-password --region ${region})`);
            const accountData = run(`aws sts get-caller-identity --output json`);
            const awsAccountId = JSON.parse(accountData).Account;

            run(`aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${awsAccountId}.dkr.ecr.${region}.amazonaws.com`,{hide:true});
            
            console.log(`Pushing local image ${repoString}:latest to xxxxxxxx.dkr.ecr.${region}.amazonaws.com/${repoString}:latest`);
            run(`docker tag "${repoString}:latest" "${awsAccountId}.dkr.ecr.${region}.amazonaws.com/${repoString}:latest"`,{hide:true,region:region});
            run(`docker push "${awsAccountId}.dkr.ecr.${region}.amazonaws.com/${repoString}:latest"  `,{hide:true, region:region});

            console.log("AWS Register Task Definition with new Environment Variables for Secrets Manager and Update Service ");
            console.log(`REGION Version set to ${AWS_DEFAULT_REGION}`);
            const oldTask = JSON.parse(run(`aws ecs describe-task-definition --task-definition ${stage}-${stack_name}-family`,{region:region}));

            try {
                console.log(`Attempting to retrieve default secrets from global region ${globalRegion}`);

                 let defaultsSecretDefinition;

                 let defaultContainerEnv = [];

                 let keys = [];
                 let newEnv = [];


                try {

                    defaultsSecretDefinition = run(`aws secretsmanager get-secret-value --secret-id default/${stack_name}`,{region:globalRegion});

                    const defaultSecretString = JSON.parse(defaultsSecretDefinition).SecretString;

                    const defaultSecretJSON = JSON.parse(defaultSecretString);

                    defaultContainerEnv = Object.keys(defaultSecretJSON).map(function(key){b = {name:key, value:defaultSecretJSON[key]};   return b;  });

                    //console.log(`Default Container Env for ${stack_name} is ${JSON.stringify(defaultContainerEnv)}`)

                    //Temporarily copy default env to task def in case user did not specify 
                    //secrets for the specified env
                    oldTask.taskDefinition.containerDefinitions.forEach(function(containerDefs){
                        containerDefs.environment= defaultContainerEnv;
                    })

                }catch (e){
                    console.log(`info: default Secrets default/${stack_name} Definition was not set`); 
                }

                console.log(`Attempting to retrieve ${stage}/${stack_name} secrets from global region ${globalRegion}`);
                
                const secretDefinition = run(`aws secretsmanager get-secret-value --secret-id ${stage}/${stack_name}`,{region:globalRegion});
                const secretString = JSON.parse(secretDefinition).SecretString;
                const secretJSON = JSON.parse(secretString);
                //console.log(secretJSON);
                let containerEnv = Object.keys(secretJSON).map(function(key){b = {name:key, value:secretJSON[key]};   return b;  });

                console.log(`Back from ${stage}/${stack_name} secrets manager. Read ${containerEnv.length} secrets`);

                console.log(`Merging Defaults with ${stage} secrets since user provided ${stage}/${stack_name} secret vars`);
                
                const mergeArr = containerEnv.concat(defaultContainerEnv);

                mergeArr.forEach(obj=> {if(keys.indexOf(obj.name) == -1){keys.push(obj.name);newEnv.push(obj);}else{console.log(`key ${obj.name} was found`);}})

                //console.log("Merged Container is ");
                //console.log(JSON.stringify(newEnv));

                //console.log(containerEnv);
                console.log("Creating new task by overwriting task def environment section");
                oldTask.taskDefinition.containerDefinitions.forEach(function(containerDefs){
                    containerDefs.environment= newEnv;
                })

            }catch(exception){
                console.log(`${stage}/${stack_name} secrets not found..using default/${stack_name} secrets. Did you remember to set ${stage}/${stack_name} in ${globalRegion} Secrets Manager?`);
            }
            console.log("Clean up Task Definition...remove unneeded attributes");
            delete oldTask.taskDefinition.taskDefinitionArn;
            delete oldTask.taskDefinition.revision;
            delete oldTask.taskDefinition.status;
            delete oldTask.taskDefinition.requiresAttributes;
            delete oldTask.taskDefinition.compatibilities;
            //Patch for https://github.com/aws/aws-cli/issues/5882
            delete oldTask.taskDefinition.registeredBy;
            delete oldTask.taskDefinition.registeredAt;
            delete oldTask.taskDefinition.deregisteredAt;
            //console.log(oldTask);
            console.log("Registering the new task definition");
            newTask = oldTask.taskDefinition;
            const revisionString = run(`aws ecs register-task-definition --region "${region}" --cli-input-json '${JSON.stringify(newTask)}'`,{hide:true,region:region});
            const revision_number = JSON.parse(revisionString).taskDefinition.revision;
            console.log(`New Revision is ${JSON.parse(revisionString).taskDefinition.revision}`);
            console.log(`Updating and restarting cluser ${stage}-${stack_name}-cluster and service ${stage}-${stack_name}-service with task ${stage}-${stack_name}-family:${revision_number}`);
            run(`aws ecs update-service --cluster "${stage}-${stack_name}-cluster"   --service "${stage}-${stack_name}-service" --force-new-deployment --task-definition ${stage}-${stack_name}-family:${revision_number}`,{region:region});

            if(slackHookUrl != "" && slackHookUrl != undefined){
                run(`curl -X POST ${slackHookUrl} -d 'payload={"text": "Restarting ${stage}-${stack_name}-service in region ${region}.  Check the site in 5 minutes"}'`,{hide:true})
            }
        } else {
            console.log(`Short Circuiting: Skipping deployment of ${stage}-${stack_name}-service in region ${region} since infrastructure does not exist in that region `);
            if(slackHookUrl != "" && slackHookUrl != undefined){
                run(`curl -X POST ${slackHookUrl} -d 'payload={"text": "Skipping deployment of ${stage}-${stack_name}-service in region ${region} since infrastructure does not exist in that region"}'`,{hide:true})
            }
        }

    }catch (e){

        let myError = e.stderr.replace(/"/g,'\\"').replace(/\n/g,"");
        
        if(slackHookUrl != "" && slackHookUrl != undefined){
            run(`curl -X POST ${slackHookUrl} -d 'payload={"text": "Failed to Deploy ${stage}-${stack_name}-service in region ${region}.\n${myError}"}'`,{hide:true})
        }
        throw myError;
    }
});




