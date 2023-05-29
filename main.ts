import { App, Editor, MarkdownView, Modal, Notice, parseYaml, Plugin, PluginSettingTab, prepareFuzzySearch, Setting, TFile } from 'obsidian';
import { CustomLeaf, Query } from 'src/types';

interface GraphExploreSettings {
	isStudying: boolean; // true if user is in a study session, false otherwise
	notesReadStatus: Record<string, boolean>; // dictionary where keys are note names and values are read status
	allowBiLinks: boolean; // if the vault has strict dependency or not

	readColor: string;
}

interface Color {
	a: number;
	rgb: string;
}
  
interface ColorGroup {
	query: string;
	color: Color;
}

interface GraphSettings {
	search: string;
	colorGroups: ColorGroup[];
}

const DEFAULT_SETTINGS: GraphExploreSettings = {
	isStudying: false, // not studying by default
	notesReadStatus: {}, // no notes read by default
	readColor: "#00FA2A",
	allowBiLinks: true,
};

const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
	search: "",
	colorGroups: [
	  	{
			query: "read: true",
			color: {
				a: 1,
				rgb: DEFAULT_SETTINGS.readColor // placeholder data
			}
	  	}
	]
};

export default class GraphExplore extends Plugin {
	settings: GraphExploreSettings;
	graphSettings: GraphSettings;
	noteFiles: TFile[];
	linkMap: Map<string, string[]>;
	filePathMap: Map<string, string>;
	fileMetaDataMap: Map<string, boolean[]>;

	async onload() {
		await this.loadSettings();

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('check', 'Obsidian Graph Explore', async (evt: MouseEvent) => {
			if (!this.settings.isStudying) {
				new Notice("You haven't started a study session yet. Please use the command to start one.");
				return
			}

			// Get current active leaf
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) {
				const noteName = activeFile.name;
				this.settings.notesReadStatus[noteName] = true;
				this.saveSettings();

				// get the current view
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);

				if(view) {
					this.setNoteMetaDataFromView(view, true, false);

					// Set all incoming links files to 'next'
					const nameNoExt = noteName.split('.')[0];
					const incomingLinks = this.getIncomingLinks(nameNoExt, this.linkMap)
					for (const afterNote of incomingLinks) {
						// check if this linked file's dependencies are all satisfied
						let setNext = true; // only if setNext is true, we can set this specific afterNote file to next=1
						const dependencies = this.linkMap.get(afterNote);
						const currentIncomingLinks = this.getIncomingLinks(afterNote, this.linkMap)
						if (dependencies) {
							for (const dependencyName of dependencies) {
								// the bi directional links stuff
								if (currentIncomingLinks.indexOf(dependencyName) !== -1 && this.settings.allowBiLinks) {
									setNext = true;
								} else {
									const filePath = this.filePathMap.get(dependencyName + '.md');
									if (filePath) {
										const fileObj = this.app.vault.getAbstractFileByPath(filePath) as TFile;
										if (fileObj) {
											const metaData = await this.readNoteMetaDataFromFile(fileObj);
											if (metaData !== null && metaData !== undefined) {
												if (!metaData[0]) {
													setNext = false;
													break;
												}
											}
										}
									}
								}
							}
						}
						if (setNext) {
							this.noteFiles.forEach((file: TFile) => {
								if (file.basename === afterNote) {
									this.setNoteMetaDataFromFile(file, false, true);
									return
								}
							})
						}
					}

					new Notice('You finished reading this note!');
					return
				}
			} else {
				new Notice("You do not appear to be reading a markdown file. Please double check you active tab is a markdown file.");
				return
			}
		});

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Not Walking the Graph');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'begin-session',
			name: 'Begin Study Session',
			callback: () => {
				let graphWindowFound = false;
				this.app.workspace.iterateAllLeaves(async (leaf) => {
					if (leaf.getViewState().type === 'graph'){
						graphWindowFound = true;
						const graphLeaf = leaf as CustomLeaf;
						// extract all files in our study scope
						this.filePathMap = new Map<string, string>();
						const filePathsInGraph = graphLeaf.view.renderer.workerResults.id
						filePathsInGraph.forEach(filePath => {
							const parts = filePath.split('/');
							this.filePathMap.set(parts[parts.length - 1], filePath);
						})

						// read all files in our study scope
						this.noteFiles = filePathsInGraph.map((filePath: string) => this.app.vault.getAbstractFileByPath(filePath) as TFile);
						this.fileMetaDataMap = new Map<string, boolean[]>();
						for (const file of this.noteFiles){
							const meta = await this.readNoteMetaDataFromFile(file)
							if (meta) {
								this.fileMetaDataMap.set(file.name, meta);
							}
						}

						// parse knowledge dependency relationships
						this.linkMap = await this.getLinkMap(this.noteFiles);

						// reset all of their meta data, but with the root notes, set next = true
						this.noteFiles.forEach((file: TFile) => {
							// determine if it's a starting root note
							const links = this.linkMap.get(file.basename);
							const isRoot = links === undefined || links.length === 0

							this.setNoteMetaDataFromFile(file, false, isRoot);
						})

						// set settings to start studying
						this.settings.isStudying = true;
						this.saveSettings();

						statusBarItemEl.setText('Walking the Graph');
						return;
					}
				});

				if (!graphWindowFound) {
					new Notice("You do not have a graph window open. Please open one and set a study scope.");
				}
			}
		});
		this.addCommand({
			id: 'end-session',
			name: 'End Study Session',
			callback: () => {
				this.settings.isStudying = false;
				this.settings.notesReadStatus = {};
				this.saveSettings();

				statusBarItemEl.setText('Not Walking the Graph');
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() {

	}

	searchNotes(query: string) {
		// Get list of all markdown files in vault
		let allNotes = this.app.vault.getMarkdownFiles();

		// Filter notes based on content
		return allNotes.filter(async (note) => {
			let content = await this.app.vault.read(note);
			return content.includes(query);
		});
	}

	async getLinkMap(notes: TFile[]) {
		// We assume that notes is an array of all the notes you're interested in
		let linkMap = new Map();
	
		for (let note of notes) {
			let content = await this.app.vault.read(note);
	
			// Updated regular expression to extract all wikilinks from note content
			let matchResult = content.match(/\[\[([^\]]+)\]\]/g);
			let links: string[] = [];
	
			if (matchResult !== null) {
				links = matchResult.map(link => {
					// Remove [[ and ]]
					link = link.slice(2, -2);
					// If there's a | symbol, only keep the part before it (the NOTE_NAME)
					let pipeIndex = link.indexOf('|');
					if (pipeIndex !== -1) {
						link = link.slice(0, pipeIndex).trim(); // trim is used to remove any leading/trailing whitespace
					}
					return link;
				});
				links = links.filter((link) => {
					let flag = false;
					notes.forEach(note => {
						if (link === note.basename){
							flag = true;
						}
					})
					return flag;
				})
				linkMap.set(note.basename, links);
			}
		}
		return linkMap;
	}


	// given a specific note and the link map, extract the incoming links (knowledge dependencies)
	getIncomingLinks(basename: string, linkMap: Map<string, string[]>): string[] {
		let incomingLinks: string[] = [];
		linkMap.forEach((links, noteBasename) => {
			if (links.includes(basename)) {
				incomingLinks.push(noteBasename);
			}
		});
		return incomingLinks;
	}

	async readNoteMetaDataFromFile(file: TFile) {
		return this.fileMetaDataMap.get(file.basename);

		const content = await this.app.vault.read(file)
		return [content.includes('read: true'), content.includes('next: true')]
	}

	async setNoteMetaDataFromView(view: MarkdownView, read: boolean, next: boolean) {
		const editor = view.editor;
		
		const doc = editor.getDoc();
		const currentContent = doc.getValue();
		let newContent = this.getMutatedNoteContents(currentContent, read, next);
		doc.setValue(newContent);

		this.fileMetaDataMap.set(view.file.basename, [read, next]);
	}

	async setNoteMetaDataFromFile(file: TFile, read: boolean, next: boolean) {
		const currentContent = await this.app.vault.cachedRead(file)
		let newContent = this.getMutatedNoteContents(currentContent, read, next);
		await this.app.vault.adapter.write(file.path, newContent);

		this.fileMetaDataMap.set(file.basename, [read, next]);
	}

	getMutatedNoteContents(currentContent: string, read: boolean, next: boolean) {
		let newContent;

		const readText = read ? 'true' : 'false';
		const nextText = next ? 'true' : 'false';

		if (currentContent.startsWith('---')) {
			let yamlMap = this.parseYamlFromNote(currentContent)
			yamlMap.set('read', readText)
			yamlMap.set('next', nextText)

			const contentAfterYaml = currentContent.split('---\n')[2];
			let yamlContent = '---\n'
			yamlMap.forEach((value: string, key: string) => {
				yamlContent += `${key}: ${value}\n`;
			})
			yamlContent += '---\n'

			newContent = yamlContent + contentAfterYaml
		} else {
			// No YAML block, simple case, just add one at the start
			newContent = `---\nread: ${readText}\nnext: ${readText}\n---\n` + currentContent;
		}
		return newContent;
	}

	parseYamlFromNote(text: string): Map<string, string> {
		// Extract the part of the string between the two '---' lines
		const yamlMatch = text.match(/---\n([\s\S]*?)\n---/);
		if (!yamlMatch) throw new Error("YAML block not found");
	
		const yamlBlock = yamlMatch[1];
	
		// Initialize the map
		const resultMap = new Map<string, string>();
	
		// Break up the YAML block into lines
		const lines = yamlBlock.split('\n');
		
		// Iterate over each line
		for (const line of lines) {
			// Split the line into key and value
			const [key, value] = line.split(':').map(s => s.trim());
	
			// Store the key-value pair in the map
			resultMap.set(key, value);
		}
		
		return resultMap;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// await this.loadGraphSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// async loadGraphSettings() {
	// 	this.app.vault.adapter.read('.obsidian/graph.json').then((data) => {
	// 		const localGraphSettings = JSON.parse(data);
	// 		this.graphSettings = Object.assign({}, DEFAULT_GRAPH_SETTINGS)
	// 		this.graphSettings.colorGroups.concat(localGraphSettings.colorGroups);
	// 	});
	// }

	// saveGraphSettings() {
	// 	this.app.vault.adapter.read('.obsidian/graph.json').then((data) => {
	// 		let localGraphSettings = JSON.parse(data);
	// 		localGraphSettings.colorGroups = this.graphSettings.colorGroups;

	// 		this.app.vault.adapter.write('.obsidian/graph.json', localGraphSettings)
	// 	});
	// }
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: GraphExplore;

	constructor(app: App, plugin: GraphExplore) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Settings for my awesome plugin.'});
				
		new Setting(containerEl)
			.setName('Allow Bi-directional Wikilinks')
			.setDesc('Enable if your vault contain Bi-directional Wikilinks, and disable if your vault use strict knowledge dependency relationships.')
			.addToggle(component => component
				.setValue(this.plugin.settings.allowBiLinks)
				.onChange(async (value) => {
					this.plugin.settings.allowBiLinks = value;
				}));
	}
}
