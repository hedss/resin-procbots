"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Promise = require("bluebird");
const ChildProcess = require("child_process");
const path = require("path");
const temp_1 = require("temp");
const procbot_1 = require("../framework/procbot");
const logger_1 = require("../utils/logger");
const exec = Promise.promisify(ChildProcess.exec);
const tempMkdir = Promise.promisify(temp_1.track().mkdir);
const tempCleanup = Promise.promisify(temp_1.cleanup);
class BuilderBot extends procbot_1.ProcBot {
    constructor(integration, name, pemString, webhook) {
        super(name);
        this.buildCode = (_registration, event) => {
            const cookedData = event.cookedEvent;
            const authToken = cookedData.githubAuthToken;
            const pushEvent = event.cookedEvent.data;
            const repo = pushEvent.repository;
            const fullName = repo.full_name;
            const owner = repo.owner.login;
            const repoName = repo.name;
            const branchRef = pushEvent.ref;
            const cliCommand = (command) => {
                return exec(command, { cwd: fullPath });
            };
            let fullPath = '';
            this.logger.log(logger_1.LogLevel.INFO, `Received a push event from the ${branchRef} of ${owner}/${repoName}`);
            return tempMkdir(`${owner}-${repoName}`).then((tempDir) => {
                fullPath = `${tempDir}${path.sep}`;
                this.logger.log(logger_1.LogLevel.INFO, `Cloning into ${fullPath}`);
                return Promise.mapSeries([
                    `git clone https://${authToken}:${authToken}@github.com/${fullName} ${fullPath}`,
                    `git checkout ${branchRef}`
                ], cliCommand);
            }).then(() => {
            }).then(() => {
            }).finally(tempCleanup);
        };
        const ghListener = this.addServiceListener('github', {
            client: name,
            loginType: {
                integrationId: integration,
                pem: pemString,
                type: 'integration'
            },
            path: '/builderhooks',
            port: 9898,
            type: 'listener',
            webhookSecret: webhook
        });
        const ghEmitter = this.addServiceEmitter('github', {
            loginType: {
                integrationId: integration,
                pem: pemString,
                type: 'integration'
            },
            pem: pemString,
            type: 'emitter'
        });
        if (!ghListener) {
            throw new Error("Couldn't create a Github listener");
        }
        if (!ghEmitter) {
            throw new Error("Couldn't create a Github emitter");
        }
        this.githubListenerName = ghListener.serviceName;
        this.githubEmitterName = ghEmitter.serviceName;
        this.githubApi = ghEmitter.apiHandle.github;
        if (!this.githubApi) {
            throw new Error('No Github API instance found');
        }
        ghListener.registerEvent({
            events: ['push'],
            listenerMethod: this.buildCode,
            name: 'BuildCode'
        });
    }
}
exports.BuilderBot = BuilderBot;
function createBot() {
    if (!(process.env.BUILDERBOT_NAME && process.env.BUILDERBOT_INTEGRATION_ID &&
        process.env.BUILDERBOT_PEM && process.env.BUILDERBOT_WEBHOOK_SECRET)) {
        throw new Error(`'BUILDERBOT_NAME', 'BUILDERBOT_INTEGRATION_ID', 'BUILDERBOT_PEM' and ` +
            `'BUILDERBOT_WEBHOOK_SECRET environment variables need setting`);
    }
    return new BuilderBot(process.env.BUILDERBOT_INTEGRATION_ID, process.env.BUILDERBOT_NAME, process.env.BUILDERBOT_PEM, process.env.BUILDERBOT_WEBHOOK_SECRET);
}
exports.createBot = createBot;

//# sourceMappingURL=builderbot.js.map
