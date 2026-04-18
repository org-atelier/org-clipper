// Stubs for browser-only modules used in CLI build.
// These are aliased by esbuild so that transitive imports
// of browser-polyfill and storage-utils resolve without error.

import type { Settings } from '../types/types';

export default {} as any;

export const generalSettings: Settings = {
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
		share: 0,
	},
	history: [],
	ratings: [],
	saveBehavior: 'saveFile',
};

export const loadSettings = async () => {};
export const saveSettings = async () => {};
export const incrementStat = async () => {};
export const getLocalStorage = async () => ({});
export const setLocalStorage = async () => {};
