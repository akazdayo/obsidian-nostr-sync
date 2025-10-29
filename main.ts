import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	moment,
} from "obsidian";
import { SimplePool, nip19 } from "nostr-tools";

interface NostrEvent {
	id: string;
	pubkey: string;
	created_at: number;
	kind: number;
	tags: string[][];
	content: string;
	sig: string;
}

interface NostrSyncSettings {
	npub: string;
	relays: string[];
	intervalMinutes: number;
	lastSyncTimestamp: number;
}

const DEFAULT_SETTINGS: NostrSyncSettings = {
	npub: "",
	relays: ["wss://relay.damus.io", "wss://nos.lol"],
	intervalMinutes: 10,
	lastSyncTimestamp: 0,
};

export default class NostrSyncPlugin extends Plugin {
	settings: NostrSyncSettings;
	syncedEventIds: Set<string>;
	pool: SimplePool;
	syncIntervalId: number | null = null;

	async onload() {
		await this.loadSettings();
		await this.loadSyncedEventIds();

		this.pool = new SimplePool();

		// Add ribbon icon for manual sync
		this.addRibbonIcon("sync", "Nostr: Sync now", async () => {
			await this.syncNostrPosts();
		});

		// Add command for manual sync
		this.addCommand({
			id: "nostr-sync-now",
			name: "Sync now",
			callback: async () => {
				await this.syncNostrPosts();
			},
		});

		// Add settings tab
		this.addSettingTab(new NostrSyncSettingTab(this.app, this));

		// Start automatic sync interval
		this.startSyncInterval();
	}

	onunload() {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
		}
		this.pool.close(this.settings.relays);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async loadSyncedEventIds() {
		const dataPath = `${this.manifest.dir}/synced-events.json`;
		try {
			const data = await this.app.vault.adapter.read(dataPath);
			this.syncedEventIds = new Set(JSON.parse(data));
		} catch (error) {
			this.syncedEventIds = new Set();
		}
	}

	async saveSyncedEventIds() {
		const dataPath = `${this.manifest.dir}/synced-events.json`;
		await this.app.vault.adapter.write(
			dataPath,
			JSON.stringify([...this.syncedEventIds]),
		);
	}

	startSyncInterval() {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
		}

		const intervalMs = this.settings.intervalMinutes * 60 * 1000;
		this.syncIntervalId = window.setInterval(async () => {
			await this.syncNostrPosts();
		}, intervalMs);

		this.registerInterval(this.syncIntervalId);
	}

	async syncNostrPosts() {
		if (!this.settings.npub) {
			new Notice("Nostr: Please configure your npub in settings");
			return;
		}

		new Notice("Nostr: Syncing posts...");

		try {
			// Decode npub to hex pubkey
			const decoded = nip19.decode(this.settings.npub);
			if (decoded.type !== "npub") {
				new Notice("Nostr: Invalid npub format");
				return;
			}
			const pubkey = decoded.data as string;

			// Fetch events from relays (only since last sync)
			const filter: any = {
				kinds: [1],
				authors: [pubkey],
			};

			// Add timestamp filter for differential sync (only get new posts)
			if (this.settings.lastSyncTimestamp > 0) {
				filter.since = this.settings.lastSyncTimestamp;
			}

			const events = await this.pool.querySync(
				this.settings.relays,
				filter,
			);

			// Filter out already synced events (extra safety check)
			const newEvents = events.filter(
				(event: NostrEvent) => !this.syncedEventIds.has(event.id),
			);

			if (newEvents.length === 0) {
				new Notice("Nostr: No new posts to sync");
				return;
			}

			// Group events by date
			const eventsByDate = new Map<string, NostrEvent[]>();
			for (const event of newEvents) {
				const date = moment.unix(event.created_at).format("YYYY-MM-DD");
				if (!eventsByDate.has(date)) {
					eventsByDate.set(date, []);
				}
				eventsByDate.get(date)!.push(event);
			}

			// Write events to daily notes
			for (const [date, dateEvents] of eventsByDate) {
				await this.writeEventsToFile(date, dateEvents);
			}

			// Mark events as synced
			for (const event of newEvents) {
				this.syncedEventIds.add(event.id);
			}
			await this.saveSyncedEventIds();

			// Update last sync timestamp to current time
			this.settings.lastSyncTimestamp = Math.floor(Date.now() / 1000);
			await this.saveSettings();

			new Notice(`Nostr: Synced ${newEvents.length} new post(s)`);
		} catch (error) {
			console.error("Nostr sync error:", error);
			new Notice(`Nostr: Sync failed - ${error.message}`);
		}
	}

	async writeEventsToFile(date: string, events: NostrEvent[]) {
		const filePath = `DailyNotes/Nostr/${date}.md`;

		// Ensure directory exists
		const dirPath = "DailyNotes/Nostr";
		try {
			await this.app.vault.createFolder(dirPath);
		} catch (error) {
			// Folder already exists, ignore error
		}

		// Sort events by timestamp
		events.sort((a, b) => a.created_at - b.created_at);

		// Generate content for new events
		let newContent = "#Nostr\n\n";
		for (const event of events) {
			const time = moment.unix(event.created_at).format("HH:mm");
			newContent += `## ${time}\n${event.content}\n\n---\n\n`;
		}

		// Check if file exists
		const file = this.app.vault.getAbstractFileByPath(filePath);

		if (file instanceof TFile) {
			// Append to existing file
			const existingContent = await this.app.vault.read(file);
			await this.app.vault.modify(file, existingContent + newContent);
		} else {
			// Create new file
			await this.app.vault.create(filePath, newContent);
		}
	}
}

class NostrSyncSettingTab extends PluginSettingTab {
	plugin: NostrSyncPlugin;

	constructor(app: App, plugin: NostrSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "Nostr Sync Settings" });

		// npub setting
		new Setting(containerEl)
			.setName("Your npub")
			.setDesc("Your Nostr public key in npub format (npub1...)")
			.addText((text) =>
				text
					.setPlaceholder("npub1...")
					.setValue(this.plugin.settings.npub)
					.onChange(async (value) => {
						this.plugin.settings.npub = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		// Relays setting
		new Setting(containerEl)
			.setName("Relays")
			.setDesc("Comma-separated list of relay URLs")
			.addTextArea((text) => {
				text.setPlaceholder("wss://relay.damus.io, wss://nos.lol")
					.setValue(this.plugin.settings.relays.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.relays = value
							.split(",")
							.map((r) => r.trim())
							.filter((r) => r.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
				text.inputEl.cols = 50;
			});

		// Interval setting
		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc(
				"How often to automatically sync posts (default: 10 minutes)",
			)
			.addText((text) =>
				text
					.setPlaceholder("10")
					.setValue(String(this.plugin.settings.intervalMinutes))
					.onChange(async (value) => {
						const num = parseInt(value);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.intervalMinutes = num;
							await this.plugin.saveSettings();
							// Restart sync interval with new setting
							this.plugin.startSyncInterval();
						}
					}),
			);
	}
}
