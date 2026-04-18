import browser from 'webextension-polyfill';
import { detectBrowser } from './utils/browser-detection';
import { updateCurrentActiveTab, isValidUrl, isBlankPage } from './utils/active-tab-manager';
import { debounce } from './utils/debounce';

const YOUTUBE_EMBED_RULE_ID = 9001;

if (browser.webRequest?.onBeforeSendHeaders) {
	browser.webRequest.onBeforeSendHeaders.addListener(
		(details) => {
			const headers = (details.requestHeaders || []).filter(
				h => h.name.toLowerCase() !== 'referer'
			);
			headers.push({ name: 'Referer', value: 'https://www.google.com/' });
			return { requestHeaders: headers };
		},
		{
			urls: ['*://*.youtube.com/embed/*'],
			types: ['sub_frame' as browser.WebRequest.ResourceType]
		},
		['blocking', 'requestHeaders']
	);
}

async function enableYouTubeEmbedRule(tabId: number): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [YOUTUBE_EMBED_RULE_ID],
		addRules: [{
			id: YOUTUBE_EMBED_RULE_ID,
			priority: 1,
			action: {
				type: 'modifyHeaders' as any,
				requestHeaders: [{
					header: 'Referer',
					operation: 'set' as any,
					value: 'https://www.google.com/'
				}]
			},
			condition: {
				urlFilter: '||youtube.com/embed/',
				resourceTypes: ['sub_frame' as any],
				tabIds: [tabId]
			}
		}]
	});
}

async function disableYouTubeEmbedRule(): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [YOUTUBE_EMBED_RULE_ID]
	});
}

let sidePanelOpenWindows: Set<number> = new Set();
let isContextMenuCreating = false;
let popupPorts: { [tabId: number]: browser.Runtime.Port } = {};

async function injectContentScript(tabId: number): Promise<void> {
	if (browser.scripting) {
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['content.js']
		});
	} else {
		await browser.tabs.executeScript(tabId, { file: 'content.js' });
	}

	let ready = false;
	for (let i = 0; i < 8; i++) {
		try {
			await browser.tabs.sendMessage(tabId, { action: "ping" });
			ready = true;
			break;
		} catch {
			// Not ready yet
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	if (!ready) {
		throw new Error('Content script did not respond after injection');
	}
}

async function ensureContentScriptLoadedInBackground(tabId: number): Promise<void> {
	try {
		const tab = await browser.tabs.get(tabId);

		if (!tab.url || !isValidUrl(tab.url)) {
			throw new Error('Invalid URL for content script injection');
		}

		await browser.tabs.sendMessage(tabId, { action: "ping" });
	} catch (error) {
		if (error instanceof Error && error.message.includes('invalid URL')) {
			throw error;
		}
		await injectContentScript(tabId);
	}
}

async function initialize() {
	try {
		await setupTabListeners();
		await debouncedUpdateContextMenu(-1);
	} catch (error) {
		console.error('Error initializing background script:', error);
	}
}

function isPopupOpen(tabId: number): boolean {
	return popupPorts.hasOwnProperty(tabId);
}

browser.runtime.onConnect.addListener((port) => {
	if (port.name === 'popup') {
		const tabId = port.sender?.tab?.id;
		if (tabId) {
			popupPorts[tabId] = port;
			port.onDisconnect.addListener(() => {
				delete popupPorts[tabId];
			});
		}
	}
});

async function sendMessageToPopup(tabId: number, message: any): Promise<void> {
	if (isPopupOpen(tabId)) {
		try {
			await popupPorts[tabId].postMessage(message);
		} catch (error) {
			console.warn(`Error sending message to popup for tab ${tabId}:`, error);
		}
	}
}

browser.runtime.onMessage.addListener(((request: unknown, sender: browser.Runtime.MessageSender, sendResponse: (response?: any) => void): true | undefined => {
	if (typeof request === 'object' && request !== null) {
		const typedRequest = request as { action: string; tabId?: number; text?: string; section?: string };

		void sendMessageToPopup;

		if (typedRequest.action === 'copy-to-clipboard' && typedRequest.text) {
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				const currentTab = tabs[0];
				if (currentTab && currentTab.id) {
					try {
						const response = await browser.tabs.sendMessage(currentTab.id, {
							action: 'copy-text-to-clipboard',
							text: typedRequest.text
						});
						if ((response as any) && (response as any).success) {
							sendResponse({success: true});
						} else {
							sendResponse({success: false, error: 'Failed to copy from content script'});
						}
					} catch (err) {
						sendResponse({ success: false, error: (err as Error).message });
					}
				} else {
					sendResponse({success: false, error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === "extractContent" && sender.tab && sender.tab.id) {
			browser.tabs.sendMessage(sender.tab.id, request).then(sendResponse);
			return true;
		}

		if (typedRequest.action === "ensureContentScriptLoaded") {
			const tabId = typedRequest.tabId || sender.tab?.id;
			if (tabId) {
				ensureContentScriptLoadedInBackground(tabId)
					.then(() => sendResponse({ success: true }))
					.catch((error) => sendResponse({
						success: false,
						error: error instanceof Error ? error.message : String(error)
					}));
				return true;
			} else {
				sendResponse({ success: false, error: 'No tab ID provided' });
				return true;
			}
		}

		if (typedRequest.action === "enableYouTubeEmbedRule") {
			const tabId = sender.tab?.id;
			if (tabId) {
				enableYouTubeEmbedRule(tabId).then(() => {
					sendResponse({ success: true });
				}).catch(() => {
					sendResponse({ success: true });
				});
			} else {
				sendResponse({ success: true });
			}
			return true;
		}

		if (typedRequest.action === "disableYouTubeEmbedRule") {
			disableYouTubeEmbedRule().then(() => {
				sendResponse({ success: true });
			}).catch(() => {
				sendResponse({ success: true });
			});
			return true;
		}

		if (typedRequest.action === "sidePanelOpened") {
			if (sender.tab && sender.tab.windowId) {
				sidePanelOpenWindows.add(sender.tab.windowId);
				updateCurrentActiveTab(sender.tab.windowId);
			}
		}

		if (typedRequest.action === "sidePanelClosed") {
			if (sender.tab && sender.tab.windowId) {
				sidePanelOpenWindows.delete(sender.tab.windowId);
			}
		}

		if (typedRequest.action === "openPopup") {
			browser.action.openPopup()
				.then(() => {
					sendResponse({ success: true });
				})
				.catch((error: unknown) => {
					console.error('Error opening popup in background script:', error);
					sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
				});
			return true;
		}

		if (typedRequest.action === "getActiveTabAndToggleIframe") {
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				const currentTab = tabs[0];
				if (currentTab && currentTab.id) {
					try {
						if (!currentTab.url || !isValidUrl(currentTab.url) || isBlankPage(currentTab.url)) {
							sendResponse({success: false, error: 'Cannot open iframe on this page'});
							return;
						}

						await ensureContentScriptLoadedInBackground(currentTab.id);
						await browser.tabs.sendMessage(currentTab.id, { action: "toggle-iframe" });
						sendResponse({success: true});
					} catch (error) {
						console.error('Error sending toggle-iframe message:', error);
						sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
					}
				} else {
					sendResponse({success: false, error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === "getActiveTab") {
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				let currentTab = tabs[0];
				if (!currentTab || !currentTab.id) {
					const allActiveTabs = await browser.tabs.query({active: true});
					currentTab = allActiveTabs.find(tab =>
						tab.id && tab.url && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('moz-extension://')
					) || allActiveTabs[0];
				}
				if (currentTab && currentTab.id) {
					sendResponse({tabId: currentTab.id});
				} else {
					sendResponse({error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === "openOptionsPage") {
			try {
				if (typeof browser.runtime.openOptionsPage === 'function') {
					browser.runtime.openOptionsPage();
				} else {
					browser.tabs.create({
						url: browser.runtime.getURL('settings.html')
					});
				}
				sendResponse({success: true});
			} catch (error) {
				console.error('Error opening options page:', error);
				sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
			}
			return true;
		}

		if (typedRequest.action === "openSettings") {
			try {
				const section = typedRequest.section ? `?section=${typedRequest.section}` : '';
				browser.tabs.create({
					url: browser.runtime.getURL(`settings.html${section}`)
				});
				sendResponse({success: true});
			} catch (error) {
				console.error('Error opening settings:', error);
				sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
			}
			return true;
		}

		if (typedRequest.action === "getTabInfo") {
			browser.tabs.get(typedRequest.tabId as number).then((tab) => {
				sendResponse({
					success: true,
					tab: {
						id: tab.id,
						url: tab.url
					}
				});
			}).catch((error) => {
				console.error('Error getting tab info:', error);
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}

		if (typedRequest.action === "forceInjectContentScript") {
			const tabId = typedRequest.tabId;
			if (tabId) {
				injectContentScript(tabId)
					.then(() => sendResponse({ success: true }))
					.catch((error) => {
						console.error('[Org Clipper] forceInjectContentScript failed:', error);
						sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
					});
				return true;
			} else {
				sendResponse({ success: false, error: 'Missing tabId' });
				return true;
			}
		}

		if (typedRequest.action === "sendMessageToTab") {
			const tabId = (typedRequest as any).tabId;
			const message = (typedRequest as any).message;
			if (tabId && message) {
				ensureContentScriptLoadedInBackground(tabId).then(() => {
					return browser.tabs.sendMessage(tabId, message);
				}).then((response) => {
					sendResponse(response);
				}).catch((error) => {
					console.error('[Org Clipper] Error sending message to tab:', error);
					sendResponse({
						success: false,
						error: error instanceof Error ? error.message : String(error)
					});
				});
				return true;
			} else {
				sendResponse({
					success: false,
					error: 'Missing tabId or message'
				});
				return true;
			}
		}

		if (typedRequest.action === "extractContent" ||
			typedRequest.action === "ensureContentScriptLoaded") {
			return true;
		}
	}
	return undefined;
}) as any);

browser.commands.onCommand.addListener(async (command, tab) => {
	if (!tab?.id) {
		const tabs = await browser.tabs.query({active: true, currentWindow: true});
		tab = tabs[0];
	}

	if (command === 'quick_clip') {
		if (tab?.id) {
			browser.action.openPopup();
			setTimeout(() => {
				browser.runtime.sendMessage({action: "triggerQuickClip"})
					.catch(error => console.error("Failed to send quick clip message:", error));
			}, 500);
		}
	}
	if (command === "copy_to_clipboard" && tab?.id) {
		await browser.tabs.sendMessage(tab.id, { action: "copyToClipboard" });
	}
});

const debouncedUpdateContextMenu = debounce(async (tabId: number) => {
	if (isContextMenuCreating) {
		return;
	}
	isContextMenuCreating = true;

	try {
		await browser.contextMenus.removeAll();

		let currentTabId = tabId;
		if (currentTabId === -1) {
			const tabs = await browser.tabs.query({ active: true, currentWindow: true });
			if (tabs.length > 0) {
				currentTabId = tabs[0].id!;
			}
		}

		const menuItems: {
			id: string;
			title: string;
			contexts: browser.Menus.ContextType[];
		}[] = [
			{
				id: "open-org-clipper",
				title: "Save this page",
				contexts: ["page", "selection", "image", "video", "audio"]
			},
			{
				id: 'open-embedded',
				title: browser.i18n.getMessage('openEmbedded'),
				contexts: ["page", "selection"]
			}
		];

		const browserType = await detectBrowser();
		if (browserType === 'chrome') {
			menuItems.push({
				id: 'open-side-panel',
				title: browser.i18n.getMessage('openSidePanel'),
				contexts: ["page", "selection"]
			});
		}

		for (const item of menuItems) {
			await browser.contextMenus.create(item);
		}
	} catch (error) {
		console.error('Error updating context menu:', error);
	} finally {
		isContextMenuCreating = false;
	}
}, 100);

browser.contextMenus.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId === "open-org-clipper") {
		browser.action.openPopup();
	} else if (info.menuItemId === 'open-embedded' && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: "toggle-iframe" });
	} else if (info.menuItemId === 'open-side-panel' && tab && tab.id && tab.windowId) {
		chrome.sidePanel.open({ tabId: tab.id });
		sidePanelOpenWindows.add(tab.windowId);
		await ensureContentScriptLoadedInBackground(tab.id);
	}
});

browser.runtime.onInstalled.addListener(() => {
	debouncedUpdateContextMenu(-1);
});

async function isSidePanelOpen(windowId: number): Promise<boolean> {
	return sidePanelOpenWindows.has(windowId);
}

async function setupTabListeners() {
	const browserType = await detectBrowser();
	if (['chrome', 'brave', 'edge'].includes(browserType)) {
		browser.tabs.onActivated.addListener(handleTabChange);
		browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
			if (changeInfo.status === 'complete') {
				handleTabChange({ tabId, windowId: tab.windowId });
			}
		});
	}
}

async function handleTabChange(activeInfo: { tabId: number; windowId?: number }) {
	if (activeInfo.windowId && await isSidePanelOpen(activeInfo.windowId)) {
		updateCurrentActiveTab(activeInfo.windowId);
	}
}

initialize().catch(error => {
	console.error('Failed to initialize background script:', error);
});
