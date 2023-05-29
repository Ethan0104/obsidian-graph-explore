import { App, WorkspaceLeaf } from "obsidian";

export interface Query {
    color: {
        a: number, 
        rgb: number
    },
    query: {
        app: App,
        caseSensitive: boolean,
        matcher: {
            regex: string,
            text: string,
        },
        query: string,
        requiredInputs: {
            content: boolean,
        }
    }
}

export interface GraphLeaf {
	view: {
		renderer: {
            worker: Worker,
			workerResults: {
                id: string[]
            };
		};
		dataEngine: {
            searchQueries: Query[],
			controlsEl: HTMLDivElement,
			getOptions(): any,
			setOptions(options: any): void
		}
	};
}

export type CustomLeaf = WorkspaceLeaf & GraphLeaf;