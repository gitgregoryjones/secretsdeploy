    const { execSync } = require('child_process');
    const fs = require('fs')
const core = require('@actions/core');

const AWS_ACCESS_KEY_ID = core.getInput('AWS_ACCESS_KEY_ID', { required: true });
const AWS_SECRET_ACCESS_KEY = core.getInput('AWS_SECRET_ACCESS_KEY', { required: true });
const stack_name = core.getInput('project_name', { required: true });
const slackHookUrl = core.getInput('SLACK_HOOK_URL');

var stage = core.getInput('stage');

const globalRegion = core.getInput('GLOBAL_REGION') || 'us-east-1';

const regionString = core.getInput('region') || 'us-east-2';

const regions = regionString.split(",");


let AWS_DEFAULT_REGION = regions[0];


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
        env: {
            ...process.env,
            AWS_ACCESS_KEY_ID,
            AWS_SECRET_ACCESS_KEY,
            AWS_DEFAULT_REGION
        },
    });
}




console.log("Trying to get git branch stage");
var branch = run(`git branch | grep "*" | sed "s/\*\s*//g"`).trim();

var info_branch = stage;

console.log(`read branch as [${branch}]`);

let extension = ".nonprod";

if(stage != "" && stage != undefined){
    branch = stage;
} else {
    stage = branch;
}

if(stage.startsWith("QAv")){
    
    console.log(`Converting Git Repo Branch [${branch}] to deployment location [qa]`);
    branch = "qa";

    stage = "qa";

} else if(stage.startsWith("staging-v")){

    console.log(`Converting Git Repo Branch [${branch}] to deployment location [staging]`);

    branch = "staging";
    stage = "staging";

} else if(stage == 'master'){
    console.log("Master branch gets deployed to production cluster");
    stage = 'production';
    extension = "";
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

    try {

        if(slackHookUrl != "" && slackHookUrl != undefined){

            run(`curl -X POST ${slackHookUrl} -d 'payload={"text": "Deploying ${stage}-${stack_name}-service in region ${region}..."}'`,{hide:true});
        }


        console.log(`Tagging and Pushing image to ${region}`);

        run(`$(aws ecr get-login --no-include-email --region ${region})`);
        const accountData = run(`aws sts get-caller-identity --output json`);
        const awsAccountId = JSON.parse(accountData).Account;

        console.log(`Pushing local image ${repoString}:latest to xxxxxxxx.dkr.ecr.${region}.amazonaws.com/${repoString}:latest`);
        run(`docker tag "${repoString}:latest" "${awsAccountId}.dkr.ecr.${region}.amazonaws.com/${repoString}:latest"`,{hide:true,region:region});
        run(`docker push "${awsAccountId}.dkr.ecr.${region}.amazonaws.com/${repoString}:latest"  `,{hide:true, region:region});

        console.log("AWS Register Task Definition with new Environment Variables for Secrets Manager and Update Service ");
        console.log(`REGION Version set to ${AWS_DEFAULT_REGION}`);
        const oldTask = JSON.parse(run(`aws ecs describe-task-definition --task-definition ${stage}-${stack_name}-family`,{region:region}));

        try {
            console.log(`Attempting to retrieve secrets from default region ${globalRegion}`);
            
            const secretDefinition = run(`aws secretsmanager get-secret-value --secret-id ${stage}/${stack_name}`,{region:globalRegion});
            const secretString = JSON.parse(secretDefinition).SecretString;
            const secretJSON = JSON.parse(secretString);
            //console.log(secretJSON);
            const containerEnv = Object.keys(secretJSON).map(function(key){b = {name:key, value:secretJSON[key]};   return b;  });
            //console.log(containerEnv);
            console.log("Creating new task by overwriting task def environment section");
            oldTask.taskDefinition.containerDefinitions.forEach(function(containerDefs){
                containerDefs.environment= containerEnv;
            })
        }catch(exception){
            console.log(`Not deploying secrets.  Did you remember to set ${stage}/${stack_name} in Secrets Manager?`);
        }
        console.log("Clean up Task Definition...remove unneeded attributes");
        delete oldTask.taskDefinition.taskDefinitionArn;
        delete oldTask.taskDefinition.revision;
        delete oldTask.taskDefinition.status;
        delete oldTask.taskDefinition.requiresAttributes;
        delete oldTask.taskDefinition.compatibilities;
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

    }catch (e){

        let myError = e.stderr.replace(/"/g,'\\"').replace(/\n/g,"");
        
        if(slackHookUrl != "" && slackHookUrl != undefined){
            run(`curl -X POST ${slackHookUrl} -d 'payload={"text": "Failed to Deploy ${stage}-${stack_name}-service in region ${region}.\n${myError}"}'`,{hide:true})
        }
        throw myError;
    }
});




