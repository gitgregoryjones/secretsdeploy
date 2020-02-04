const { execSync } = require('child_process');
const core = require('@actions/core');

const AWS_ACCESS_KEY_ID = core.getInput('access_key_id', { required: true });
const AWS_SECRET_ACCESS_KEY = core.getInput('secret_access_key', { required: true });
const stack_name = core.getInput('project_name', { required: true });
const stage = core.getInput('stage') || "prod";
const awsRegion = core.getInput('region') || process.env.AWS_DEFAULT_REGION || 'us-east-2';


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
        },
    });
}

console.log("-Building Dockerfile")
run(`docker build -f Dockerfile -t "${stack_name}-repo" .`);

console.log("AWS GET Account, Login And Upload To ECR");

run(`$(aws ecr get-login --no-include-email --region ${awsRegion})`);
const accountData = run(`aws sts get-caller-identity --output json`);
const awsAccountId = JSON.parse(accountData).Account;

console.log(`Pushing local image ${stack_name}-repo:latest to xxxxxxxx.dkr.ecr.${awsRegion}.amazonaws.com/${stack_name}-repo:latest`);
run(`docker tag "${stack_name}-repo:latest" "${awsAccountId}.dkr.ecr.${awsRegion}.amazonaws.com/${stack_name}-repo:latest"`,{hide:true});
run(`docker push "${awsAccountId}.dkr.ecr.${awsRegion}.amazonaws.com/${stack_name}-repo:latest"  `,{hide:true});

console.log("AWS Register Task Definition with new Environment Variables for Secrets Manager and Update Service ");
const oldTask = JSON.parse(run(`aws ecs describe-task-definition --task-definition ${stack_name}-family`));
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
console.log(`Updating and restarting cluser ${stack_name}-cluster and service ${stack_name}-service with task ${stack_name}-family:${revision_number}`);
run(`aws ecs update-service --cluster "${stack_name}-cluster"   --service "${stack_name}-service" --force-new-deployment --task-definition ${stack_name}-family:${revision_number}`);
