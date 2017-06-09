"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Promise = require("bluebird");
const procbot_1 = require("../framework/procbot");
const logger_1 = require("../utils/logger");
class BuilderBot extends procbot_1.ProcBot {
    constructor(integration, name, pemString, webhook) {
        super(name);
        this.buildCode = (_registration, event) => {
            const pushEvent = event.cookedEvent.data;
            this.logger.log(logger_1.LogLevel.INFO, 'Received a push event');
            console.log(pushEvent);
            return Promise.resolve();
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
