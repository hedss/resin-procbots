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

// Github Events --------------------------------------------------------------
// These provide the current bare minimum definitions for child Procbots working with them.

export interface PullRequestEvent {
    type: 'pull_request';
    action: string;
    pull_request: PullRequest;
    sender: {
        login: string;
    };
}

export interface PullRequestReviewEvent {
    type: 'pull_request_review';
    action: string;
    pull_request: PullRequest;
}

export interface StatusEventBranch {
    name: string;
    commit: {
        author: {
            login: string;
        }
        sha: string;
        url: string;
    };
}

export interface StatusEvent {
    context: string;
    name: string;
    sha: string;
    branches: StatusEventBranch[];
}

// Github API -----------------------------------------------------------------
// These provide the current bare minimum definitions for child Procbots working with them.
export interface Comment {
    body: string;
    user: {
        login: string;
        type: string;
    };
    created_at: string;
    updated_at: string;
}

export interface CommitFile {
    filename: string;
}

export interface Commit {
    committer: {
        login: string;
    };
    commit: {
        committer: {
            name: string;
            date: string;
        }
        message: string;
    };
    files: CommitFile[];
    sha: string;
}

export interface Content {
    type: string;
    encoding: string;
    size: number;
    name: string;
    path: string;
    content: string;
    sha: string;
}

export interface Review {
    state: string;
}

export interface Merge {
    sha: string;
}

export interface Tag {
    sha: string;
}

export interface PullRequest {
    head: {
        ref: string;
        repo: {
            owner: {
                login: string;
            }
            name: string;
        };
        sha: string;
    };
    html_url: string;
    mergeable: boolean;
    mergeable_state: string;
    number: number;
    state: string;
    url: string;
    user: {
        login: string;
    };
}

export interface Blob {
    sha: string;
}

export interface TreeEntry {
    path: string;
    mode: string;
    type: string;
    sha: string;
    url?: string;
    size?: number;
}

export interface Tree {
    sha: string;
    url: string;
    tree: TreeEntry[];
}

export interface RequiredStatusChecks {
    include_admins: boolean;
    strict: boolean;
    contexts: string[];
}

export interface IssueLabel {
    default: boolean;
    id: string;
    name: string;
}

export interface Status {
    state: string;
    context: string;
}

export interface CombinedStatus {
    state: string;
    total_count: number;
    statuses: Status[];
}
