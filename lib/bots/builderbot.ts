/*
Copyright 2016-2017 Resin.io

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// BuilderBot listens for merges of a PR to the `master` branch and then
// updates any packages for it.
import * as Promise from 'bluebird';
import * as GithubApi from 'github';
import * as GithubApiTypes from '../apis/githubapi-types';
import { ProcBot } from '../framework/procbot';
import { GithubHandle, GithubRegistration } from '../services/github-types';
import { ServiceEvent } from '../services/service-types';
import { LogLevel } from '../utils/logger';

export class BuilderBot extends ProcBot {
    /** Github ServiceListener. */
    private githubListenerName: string;
    /** Github ServiceEmitter. */
    private githubEmitterName: string;
    /** Instance of Github SDK API in use. */
    private githubApi: GithubApi;

    /**
     * Constructs a new BuilderBot instance.
     * @param integration Github App ID.
     * @param name        Name of the BuilderBot.
     * @param pemString   PEM for Github events and App login.
     * @param webhook     Secret webhook for validating events.
     */
    constructor(integration: number, name: string, pemString: string, webhook: string) {
        // This is the BuilderBot.
        super(name);

        // Create a new listener for Github with the right Integration ID.
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

        // Create a new emitter with the right Integration ID.
        const ghEmitter = this.addServiceEmitter('github', {
            loginType: {
                integrationId: integration,
                pem: pemString,
                type: 'integration'
            },
            pem: pemString,
            type: 'emitter'
        });

        // Throw if we didn't get either of the services.
        if (!ghListener) {
            throw new Error("Couldn't create a Github listener");
        }
        if (!ghEmitter) {
            throw new Error("Couldn't create a Github emitter");
        }
        this.githubListenerName = ghListener.serviceName;
        this.githubEmitterName = ghEmitter.serviceName;

        // Github API handle
        this.githubApi = (<GithubHandle>ghEmitter.apiHandle).github;
        if (!this.githubApi) {
            throw new Error('No Github API instance found');
        }

        ghListener.registerEvent({
            events: [ 'push' ],
            listenerMethod: this.buildCode,
            name: 'BuildCode'
        });
    }

    protected buildCode = (_registration: GithubRegistration, event: ServiceEvent): Promise<void> => {
        const pushEvent: GithubApiTypes.PushEvent = event.cookedEvent.data;
        this.logger.log(LogLevel.INFO, 'Received a push event');
        console.log(pushEvent);
        return Promise.resolve();
    }
}

/**
 * Creates a new instance of the BuilderBot client.
 */
export function createBot(): BuilderBot {
    if (!(process.env.BUILDERBOT_NAME && process.env.BUILDERBOT_INTEGRATION_ID &&
    process.env.BUILDERBOT_PEM && process.env.BUILDERBOT_WEBHOOK_SECRET)) {
        throw new Error(`'BUILDERBOT_NAME', 'BUILDERBOT_INTEGRATION_ID', 'BUILDERBOT_PEM' and ` +
            `'BUILDERBOT_WEBHOOK_SECRET environment variables need setting`);
    }

    return new BuilderBot(process.env.BUILDERBOT_INTEGRATION_ID, process.env.BUILDERBOT_NAME,
    process.env.BUILDERBOT_PEM, process.env.BUILDERBOT_WEBHOOK_SECRET);
}
