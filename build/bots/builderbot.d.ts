import * as Promise from 'bluebird';
import { ProcBot } from '../framework/procbot';
import { GithubRegistration } from '../services/github-types';
import { ServiceEvent } from '../services/service-types';
export declare class BuilderBot extends ProcBot {
    private githubListenerName;
    private githubEmitterName;
    private githubApi;
    constructor(integration: number, name: string, pemString: string, webhook: string);
    protected buildCode: (_registration: GithubRegistration, event: ServiceEvent) => Promise<void>;
}
export declare function createBot(): BuilderBot;
