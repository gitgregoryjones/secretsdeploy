    const { execSync } = require('child_process');
const core = require('@actions/core');

const AWS_ACCESS_KEY_ID = core.getInput('AWS_ACCESS_KEY_ID', { required: true });
const AWS_SECRET_ACCESS_KEY = core.getInput('AWS_SECRET_ACCESS_KEY', { required: true });
const stack_name = core.getInput('project_name', { required: true });
var stage = core.getInput('stage');
const awsRegion = core.getInput('region') || 'us-east-2';


const AWS_DEFAULT_REGION = awsRegion;


function run(cmd, options = {}) {
    if (!options.hide) {
        console.log(`$ ${cmd}`);
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


if(stage != "" && stage != undefined){
    branch = stage;
} else {
    stage = branch;
}

if(stage == 'master'){
    console.log("Staging branch gets deployed to production cluster");
    stage = 'production';
}

let repoString = `${stage}-${stack_name}-repo`;

console.log(`Stage is ${branch}`)

console.log("-Building Dockerfile")
run(`docker build -f Dockerfile -t "${repoString}" .`);

console.log("AWS GET Account, Login And Upload To ECR");

run(`$(aws ecr get-login --no-include-email --region ${awsRegion})`);
const accountData = run(`aws sts get-caller-identity --output json`);
const awsAccountId = JSON.parse(accountData).Account;

console.log(`Pushing local image ${repoString}:latest to xxxxxxxx.dkr.ecr.${awsRegion}.amazonaws.com/${repoString}:latest`);
run(`docker tag "${repoString}:latest" "${awsAccountId}.dkr.ecr.${awsRegion}.amazonaws.com/${repoString}:latest"`,{hide:true});
run(`docker push "${awsAccountId}.dkr.ecr.${awsRegion}.amazonaws.com/${repoString}:latest"  `,{hide:true});

console.log("AWS Register Task Definition with new Environment Variables for Secrets Manager and Update Service ");
console.log(`REGION Version set to ${AWS_DEFAULT_REGION}`);
const oldTask = JSON.parse(run(`aws ecs describe-task-definition --task-definition ${stage}-${stack_name}-family`));

try {
    const secretDefinition = run(`aws secretsmanager get-secret-value --secret-id ${stage}/${stack_name}`);
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
const revisionString = run(`aws ecs register-task-definition --region "${awsRegion}" --cli-input-json '${JSON.stringify(newTask)}'`,{hide:true});
const revision_number = JSON.parse(revisionString).taskDefinition.revision;
console.log(`New Revision is ${JSON.parse(revisionString).taskDefinition.revision}`);
console.log(`Updating and restarting cluser ${stage}-${stack_name}-cluster and service ${stage}-${stack_name}-service with task ${stage}-${stack_name}-family:${revision_number}`);
run(`aws ecs update-service --cluster "${stage}-${stack_name}-cluster"   --service "${stage}-${stack_name}-service" --force-new-deployment --task-definition ${stage}-${stack_name}-family:${revision_number}`);
