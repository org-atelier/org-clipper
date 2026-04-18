import browser from './browser-polyfill';
import { Settings, PropertyType, HistoryEntry, Rating } from '../types/types';
import { debugLog } from './debug';

export type { Settings, PropertyType, HistoryEntry, Rating };

export let generalSettings: Settings = {
	vaults: [],
	betaFeatures: false,
	legacyMode: false,
	silentOpen: false,
	openBehavior: 'popup',
	showMoreActionsButton: false,
	propertyTypes: [],
	stats: {
		saveFile: 0,
		copyToClipboard: 0,
		share: 0
	},
	history: [],
	ratings: [],
	saveBehavior: 'saveFile'
};

export function setLocalStorage(key: string, value: any): Promise<void> {
	return browser.storage.local.set({ [key]: value });
}

export function getLocalStorage(key: string): Promise<any> {
	return browser.storage.local.get(key).then((result: {[key: string]: any}) => result[key]);
}

interface StorageData {
	general_settings?: {
		showMoreActionsButton?: boolean;
		betaFeatures?: boolean;
		legacyMode?: boolean;
		silentOpen?: boolean;
		openBehavior?: boolean | 'popup' | 'embedded';
		saveBehavior?: 'saveFile' | 'copyToClipboard';
	};
	vaults?: string[];
	property_types?: PropertyType[];
	stats?: {
		saveFile: number;
		copyToClipboard: number;
		share: number;
	};
	history?: HistoryEntry[];
	ratings?: Rating[];
	migrationVersion?: number;
}

const CURRENT_MIGRATION_VERSION = 2;

export async function loadSettings(): Promise<Settings> {
	const data = await browser.storage.sync.get(null) as StorageData;

	const defaultSettings: Settings = {
		vaults: [],
		showMoreActionsButton: false,
		betaFeatures: false,
		legacyMode: false,
		silentOpen: false,
		openBehavior: 'popup',
		propertyTypes: [],
		saveBehavior: 'saveFile',
		stats: {
			saveFile: 0,
			copyToClipboard: 0,
			share: 0
		},
		history: [],
		ratings: [],
	};

	if (!data.migrationVersion || data.migrationVersion < CURRENT_MIGRATION_VERSION) {
		await browser.storage.sync.set({ migrationVersion: CURRENT_MIGRATION_VERSION });
		debugLog('Settings', `Updated migration version to ${CURRENT_MIGRATION_VERSION}`);
	}

	const sanitizedVaults = Array.isArray(data.vaults) ? data.vaults.filter(v => typeof v === 'string') : [];

	const loadedSettings: Settings = {
		vaults: sanitizedVaults.length > 0 ? sanitizedVaults : defaultSettings.vaults,
		showMoreActionsButton: data.general_settings?.showMoreActionsButton ?? defaultSettings.showMoreActionsButton,
		betaFeatures: data.general_settings?.betaFeatures ?? defaultSettings.betaFeatures,
		legacyMode: data.general_settings?.legacyMode ?? defaultSettings.legacyMode,
		silentOpen: data.general_settings?.silentOpen ?? defaultSettings.silentOpen,
		openBehavior: typeof data.general_settings?.openBehavior === 'boolean'
			? (data.general_settings.openBehavior ? 'embedded' : 'popup')
			: (data.general_settings?.openBehavior ?? defaultSettings.openBehavior),
		propertyTypes: data.property_types || defaultSettings.propertyTypes,
		stats: data.stats || defaultSettings.stats,
		history: data.history || defaultSettings.history,
		ratings: data.ratings || defaultSettings.ratings,
		saveBehavior: data.general_settings?.saveBehavior ?? defaultSettings.saveBehavior
	};

	generalSettings = loadedSettings;
	debugLog('Settings', 'Loaded settings:', generalSettings);
	return generalSettings;
}

export async function saveSettings(settings?: Partial<Settings>): Promise<void> {
	if (settings) {
		generalSettings = { ...generalSettings, ...settings };
	}

	await browser.storage.sync.set({
		vaults: generalSettings.vaults,
		general_settings: {
			showMoreActionsButton: generalSettings.showMoreActionsButton,
			betaFeatures: generalSettings.betaFeatures,
			legacyMode: generalSettings.legacyMode,
			silentOpen: generalSettings.silentOpen,
			openBehavior: generalSettings.openBehavior,
			saveBehavior: generalSettings.saveBehavior,
		},
		property_types: generalSettings.propertyTypes,
		stats: generalSettings.stats
	});
}

export async function setLegacyMode(enabled: boolean): Promise<void> {
	await saveSettings({ legacyMode: enabled });
}

export async function incrementStat(
	action: keyof Settings['stats'],
	vault?: string,
	path?: string,
	url?: string,
	title?: string
): Promise<void> {
	const settings = await loadSettings();
	settings.stats[action]++;
	await saveSettings(settings);

	if (url) {
		await addHistoryEntry(action, url, title, vault, path);
	}
}

export async function addHistoryEntry(
	action: keyof Settings['stats'],
	url: string,
	title?: string,
	vault?: string,
	path?: string
): Promise<void> {
	const entry: HistoryEntry = {
		datetime: new Date().toISOString(),
		url,
		action,
		title,
		vault,
		path
	};

	const result = await browser.storage.local.get('history');
	const history: HistoryEntry[] = (result.history || []) as HistoryEntry[];

	history.unshift(entry);

	const trimmedHistory = history.slice(0, 1000);

	await browser.storage.local.set({ history: trimmedHistory });
}

export async function getClipHistory(): Promise<HistoryEntry[]> {
	const result = await browser.storage.local.get('history');
	return (result.history || []) as HistoryEntry[];
}

declare global {
	interface Window {
		debugStorage: (key?: string) => Promise<Record<string, unknown>>;
	}
}

if (typeof window !== 'undefined') {
	window.debugStorage = (key?: string) => {
		if (key) {
			return browser.storage.sync.get(key).then(data => {
				console.log(`Sync storage contents for key "${key}":`, data);
				return data;
			});
		}
		return browser.storage.sync.get(null).then(data => {
			console.log('Sync storage contents:', data);
			return data;
		});
	};
}
