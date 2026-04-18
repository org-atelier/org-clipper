import { Template, Property } from '../types/types';
import { incrementStat } from '../utils/storage-utils';
import { extractPageContent, initializePageContent } from '../utils/content-extractor';
import { compileTemplate } from '../utils/template-compiler';
import { initializeIcons, getPropertyTypeIcon } from '../icons/icons';
import { findMatchingTemplate, initializeTriggers } from '../utils/triggers';
import { getLocalStorage, setLocalStorage, loadSettings, generalSettings, Settings } from '../utils/storage-utils';
import { unescapeValue } from '../utils/string-utils';
import { loadTemplates } from '../managers/template-manager';
import browser from '../utils/browser-polyfill';
import { addBrowserClassToHtml, detectBrowser } from '../utils/browser-detection';
import { createElementWithClass } from '../utils/dom-utils';
import { adjustNoteNameHeight } from '../utils/ui-utils';
import { debugLog } from '../utils/debug';
import { showVariables, initializeVariablesPanel, updateVariablesPanel } from '../managers/inspect-variables';
import { isBlankPage, isValidUrl, isRestrictedUrl } from '../utils/active-tab-manager';
import { memoizeWithExpiration } from '../utils/memoize';
import { debounce } from '../utils/debounce';
import { saveFile } from '../utils/file-utils';
import { translatePage, getMessage, setupLanguageAndDirection } from '../utils/i18n';
import { formatPropertyValue } from '../utils/shared';
import { getFormatter } from '../formatters';
import { denoteFilename } from '../utils/denote';

let loadedSettings: Settings;
let currentTemplate: Template | null = null;
let templates: Template[] = [];
let currentVariables: { [key: string]: string } = {};
let currentTabId: number | undefined;

const isSidePanel = window.location.pathname.includes('side-panel.html');
const urlParams = new URLSearchParams(window.location.search);
const isIframe = urlParams.get('context') === 'iframe';

const memoizedCompileTemplate = memoizeWithExpiration(
	async (tabId: number, template: string, variables: { [key: string]: string }, currentUrl: string) => {
		return compileTemplate(tabId, template, variables, currentUrl);
	},
	{
		expirationMs: 5000,
		keyFn: (tabId: number, template: string, variables: { [key: string]: string }, currentUrl: string) =>
			`${tabId}-${template}-${currentUrl}`
	}
);

function generateOrgMeta(properties: Property[]): string {
	const formatter = getFormatter();
	const typeMap: Record<string, string> = {};
	for (const pt of generalSettings.propertyTypes) {
		typeMap[pt.name] = pt.type;
	}
	return formatter.formatMeta(properties, typeMap);
}

function getPropertiesFromDOM(): Property[] {
	return Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
		const inputElement = input as HTMLInputElement;
		return {
			id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
			name: inputElement.id,
			value: inputElement.type === 'checkbox' ? String(inputElement.checked) : inputElement.value
		};
	}) as Property[];
}

async function getTabInfo(tabId: number): Promise<{ id: number; url: string }> {
	const response = await browser.runtime.sendMessage({ action: "getTabInfo", tabId }) as { success?: boolean; tab?: { id: number; url: string }; error?: string };
	if (!response || !response.success || !response.tab) {
		throw new Error((response && response.error) || 'Failed to get tab info');
	}
	return response.tab;
}

async function getCurrentTabInfo(): Promise<{ url: string; title?: string }> {
	if (!currentTabId) {
		return { url: '' };
	}
	try {
		const tab = await getTabInfo(currentTabId);
		const extractedData = await memoizedExtractPageContent(currentTabId);
		return { url: tab.url, title: extractedData?.title || document.title };
	} catch {
		return { url: '' };
	}
}

const memoizedExtractPageContent = memoizeWithExpiration(
	async (tabId: number) => {
		await getTabInfo(tabId);
		return extractPageContent(tabId);
	},
	{
		expirationMs: 5000,
		keyFn: async (tabId: number) => {
			const tab = await getTabInfo(tabId);
			return `${tabId}-${tab.url}`;
		}
	}
);

let previousWidth = window.innerWidth;

function setPopupDimensions() {
	const actualHeight = document.documentElement.offsetHeight;
	const viewportHeight = window.innerHeight;
	const viewportWidth = window.innerWidth;
	const finalHeight = Math.min(actualHeight, viewportHeight);

	document.documentElement.style.setProperty('--chromium-popup-height', `${finalHeight}px`);

	if (viewportWidth !== previousWidth) {
		previousWidth = viewportWidth;
		const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
		if (noteNameField) {
			adjustNoteNameHeight(noteNameField);
		}
	}
}

const debouncedSetPopupDimensions = debounce(setPopupDimensions, 100);

async function initializeExtension(tabId: number): Promise<boolean> {
	try {
		await translatePage();
		await setupLanguageAndDirection();
		await addBrowserClassToHtml();

		document.documentElement.style.setProperty('--chromium-popup-height', '2000px');
		setTimeout(setPopupDimensions, 0);

		templates = await loadTemplates();
		if (templates.length === 0) {
			console.error('No templates loaded');
			return false;
		}

		initializeTriggers(templates);
		currentTemplate = templates[0];

		const tab = await getTabInfo(tabId);
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return false;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return false;
		}
		if (isRestrictedUrl(tab.url)) {
			showError('pageCannotBeClipped');
			return false;
		}

		setupMessageListeners();
		return true;
	} catch (error) {
		console.error('Error initializing extension:', error);
		showError('failedToInitialize');
		return false;
	}
}

function setupMessageListeners() {
	browser.runtime.onMessage.addListener(((request: any) => {
		if (request.action === "triggerQuickClip") {
			handleSaveToDownloads().catch(err => console.error('Quick clip failed:', err));
		} else if (request.action === "tabUrlChanged") {
			if (request.tabId === currentTabId && currentTabId !== undefined) {
				refreshFields(currentTabId);
			}
		} else if (request.action === "activeTabChanged") {
			if (!isIframe) {
				currentTabId = request.tabId;
				if (request.isRestrictedUrl || request.isBlankPage) {
					showError('pageCannotBeClipped');
				} else if (request.isValidUrl) {
					if (currentTabId !== undefined) refreshFields(currentTabId);
				} else {
					showError('onlyHttpSupported');
				}
			}
		}
	}) as any);
}

document.addEventListener('DOMContentLoaded', async function() {
	loadedSettings = await loadSettings();
	if (isIframe) {
		document.documentElement.classList.add('is-embedded');
	}

	const currentIsSidePanel = document.documentElement.classList.contains('is-side-panel');

	try {
		const response = await browser.runtime.sendMessage({ action: "getActiveTab" }) as { tabId?: number; error?: string };
		if (!response || response.error || !response.tabId) {
			showError('pleaseReload');
			return;
		}

		currentTabId = response.tabId;
		const tab = await getTabInfo(currentTabId);
		const currentBrowser = await detectBrowser();
		const isMobile = currentBrowser === 'mobile-safari';

		const openBehavior: Settings['openBehavior'] = isMobile ? 'popup' : loadedSettings.openBehavior;

		if (isValidUrl(tab.url) && !isBlankPage(tab.url) && openBehavior === 'embedded' && !isIframe && !currentIsSidePanel) {
			try {
				const iframeResponse = await browser.runtime.sendMessage({ action: "getActiveTabAndToggleIframe" }) as { success?: boolean; error?: string };
				if (iframeResponse && iframeResponse.success) {
					window.close();
					return;
				}
			} catch (error) {
				console.error('Error toggling iframe:', error);
			}
		}

		browser.runtime.connect({ name: 'popup' });

		const refreshButton = document.getElementById('refresh-pane');
		if (refreshButton) {
			refreshButton.addEventListener('click', (e) => {
				e.preventDefault();
				refreshPopup();
				initializeIcons(refreshButton);
			});
		}
		const settingsButton = document.getElementById('open-settings');
		if (settingsButton) {
			settingsButton.addEventListener('click', async function() {
				try {
					await browser.runtime.sendMessage({ action: "openOptionsPage" });
					setTimeout(() => window.close(), 50);
				} catch (error) {
					console.error('Error opening options page:', error);
				}
			});
			initializeIcons(settingsButton);
		}

		if (currentTabId) {
			const initialized = await initializeExtension(currentTabId);
			if (!initialized) return;

			try {
				populateTemplateDropdown();
				setupEventListeners(currentTabId);
				await initializeUI();
				determineMainAction();

				const showMoreActionsButton = document.getElementById('show-variables');
				if (showMoreActionsButton) {
					showMoreActionsButton.addEventListener('click', (e) => {
						e.preventDefault();
						showVariables();
					});
				}

				await refreshFields(currentTabId);
			} catch (error) {
				console.error('Error initializing popup:', error);
				showError('pleaseReload');
			}
		} else {
			showError('pleaseReload');
		}
	} catch (error) {
		console.error('Error in DOMContentLoaded handler:', error);
		showError('pleaseReload');
	}
});

function setupEventListeners(_tabId: number) {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown) {
		templateDropdown.addEventListener('change', function(this: HTMLSelectElement) {
			handleTemplateChange(this.value);
		});
	}

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.addEventListener('input', () => adjustNoteNameHeight(noteNameField));
		noteNameField.addEventListener('keydown', function(e) {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
			}
		});
	}

	const embeddedModeButton = document.getElementById('embedded-mode');
	if (embeddedModeButton) {
		embeddedModeButton.addEventListener('click', async function() {
			try {
				await browser.runtime.sendMessage({ action: "getActiveTabAndToggleIframe" });
				setTimeout(() => window.close(), 50);
			} catch (error) {
				console.error('Error toggling embedded iframe:', error);
			}
		});
	}

	const moreButton = document.getElementById('more-btn');
	const moreDropdown = document.getElementById('more-dropdown');
	const copyContentButton = document.getElementById('copy-content');
	const saveDownloadsButton = document.getElementById('save-downloads');

	if (moreButton && moreDropdown) {
		moreButton.addEventListener('click', (e) => {
			e.stopPropagation();
			moreDropdown.classList.toggle('show');
		});

		document.addEventListener('click', (e) => {
			if (!moreButton.contains(e.target as Node)) {
				moreDropdown.classList.remove('show');
			}
		});
	}

	if (copyContentButton) {
		copyContentButton.addEventListener('click', copyContent);
	}

	if (saveDownloadsButton) {
		saveDownloadsButton.addEventListener('click', handleSaveToDownloads);
	}
}

async function initializeUI() {
	const clipButton = document.getElementById('clip-btn');
	if (clipButton) {
		clipButton.focus();
	}

	const showMoreActionsButton = document.getElementById('show-variables') as HTMLElement;
	const variablesPanel = document.createElement('div');
	variablesPanel.className = 'variables-panel';
	document.body.appendChild(variablesPanel);

	if (showMoreActionsButton) {
		showMoreActionsButton.addEventListener('click', async (e) => {
			e.preventDefault();
			initializeVariablesPanel(variablesPanel, currentTemplate, currentVariables);
			await showVariables();
		});
	}

	if (isSidePanel) {
		browser.runtime.sendMessage({ action: "sidePanelOpened" });
	}
}

function showError(messageKey: string): void {
	const errorMessage = document.querySelector('.error-message') as HTMLElement;
	const clipper = document.querySelector('.clipper') as HTMLElement;

	if (errorMessage && clipper) {
		errorMessage.textContent = getMessage(messageKey);
		errorMessage.style.display = 'flex';
		clipper.style.display = 'none';
		document.body.classList.add('has-error');
	}
}

async function refreshFields(tabId: number, checkTemplateTriggers: boolean = true) {
	if (templates.length === 0) {
		showError('noTemplates');
		return;
	}

	try {
		const tab = await getTabInfo(tabId);
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return;
		}
		if (isRestrictedUrl(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}

		const extractionPromise = memoizedExtractPageContent(tabId);

		if (checkTemplateTriggers) {
			const getSchemaOrgData = async () => {
				const data = await extractionPromise;
				return data?.schemaOrgData;
			};

			const matchedTemplate = await findMatchingTemplate(tab.url, getSchemaOrgData);
			if (matchedTemplate) {
				currentTemplate = matchedTemplate;
				updateTemplateDropdown();
			}
		}

		buildTemplateFieldsSkeleton(currentTemplate);
		setupMetadataToggle();

		const extractedData = await extractionPromise;
		if (!extractedData) {
			throw new Error('Unable to extract page content.');
		}

		const initializedContent = await initializePageContent(
			extractedData.content,
			extractedData.selectedHtml,
			extractedData.extractedContent,
			tab.url,
			extractedData.schemaOrgData,
			extractedData.fullHtml,
			[],
			extractedData.title,
			extractedData.author,
			extractedData.description,
			extractedData.favicon,
			extractedData.image,
			extractedData.published,
			extractedData.site,
			extractedData.wordCount,
			extractedData.language || '',
			extractedData.metaTags
		);

		if (!initializedContent) {
			throw new Error('Unable to initialize page content.');
		}

		currentVariables = initializedContent.currentVariables;
		await fillTemplateFieldValues(tabId, currentTemplate, initializedContent.currentVariables);
		updateVariablesPanel(currentTemplate, currentVariables);
	} catch (error) {
		console.error('Error refreshing fields:', error);
		const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
		showError(errorMessage);
	}
}

function updateTemplateDropdown() {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown && currentTemplate) {
		templateDropdown.value = currentTemplate.id;
	}
}

function populateTemplateDropdown() {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown && currentTemplate) {
		templateDropdown.textContent = '';
		templates.forEach((template: Template) => {
			const option = document.createElement('option');
			option.value = template.id;
			option.textContent = template.name;
			templateDropdown.appendChild(option);
		});
		templateDropdown.value = currentTemplate.id;
	}
}

function buildTemplateFieldsSkeleton(template: Template | null) {
	if (!template) return;

	const existingTemplateProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const newTemplateProperties = createElementWithClass('div', 'metadata-properties');

	if (Array.isArray(template.properties)) {
		for (const property of template.properties) {
			const propertyDiv = createElementWithClass('div', 'metadata-property');
			const propertyType = generalSettings.propertyTypes.find(p => p.name === property.name)?.type || 'text';

			const metadataPropertyKey = document.createElement('div');
			metadataPropertyKey.className = 'metadata-property-key';

			const propertyIconSpan = document.createElement('span');
			propertyIconSpan.className = 'metadata-property-icon';
			const iconElement = document.createElement('i');
			iconElement.setAttribute('data-lucide', getPropertyTypeIcon(propertyType));
			propertyIconSpan.appendChild(iconElement);

			const propertyLabel = document.createElement('label');
			propertyLabel.setAttribute('for', property.name);
			propertyLabel.textContent = property.name;

			metadataPropertyKey.appendChild(propertyIconSpan);
			metadataPropertyKey.appendChild(propertyLabel);

			const metadataPropertyValue = document.createElement('div');
			metadataPropertyValue.className = 'metadata-property-value';

			const inputElement = document.createElement('input');
			inputElement.id = property.name;
			inputElement.setAttribute('data-type', propertyType);
			inputElement.setAttribute('data-template-value', property.value);
			inputElement.type = propertyType === 'checkbox' ? 'checkbox' : 'text';

			metadataPropertyValue.appendChild(inputElement);

			propertyDiv.appendChild(metadataPropertyKey);
			propertyDiv.appendChild(metadataPropertyValue);
			newTemplateProperties.appendChild(propertyDiv);
		}
	}

	if (existingTemplateProperties && existingTemplateProperties.parentNode) {
		existingTemplateProperties.parentNode.replaceChild(newTemplateProperties, existingTemplateProperties);
		existingTemplateProperties.remove();
	}

	initializeIcons(newTemplateProperties);

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.setAttribute('data-template-value', template.noteNameFormat);
	}

	const pathField = document.getElementById('path-name-field') as HTMLInputElement;
	const pathContainer = document.querySelector('.vault-path-container') as HTMLElement;
	if (pathField && pathContainer) {
		pathContainer.style.display = 'flex';
		pathField.setAttribute('data-template-value', template.path);
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	if (noteContentField) {
		noteContentField.setAttribute('data-template-value', template.noteContentFormat || '');
	}
}

// Cache for org-converted content to avoid re-conversion on template switch
let cachedOrgContent: string | null = null;

async function fillTemplateFieldValues(tabId: number, template: Template | null, variables: { [key: string]: string }) {
	if (!template) return;

	const currentUrl = tabId ? (await getTabInfo(tabId)).url || '' : '';

	// Re-compute {{content}} as org-mode from HTML
	if (variables['{{contentHtml}}']) {
		if (!cachedOrgContent) {
			const formatter = getFormatter();
			cachedOrgContent = formatter.formatContent(variables['{{contentHtml}}'], currentUrl);
		}
		variables = { ...variables, '{{content}}': cachedOrgContent };
	}

	currentVariables = variables;

	if (!Array.isArray(template.properties)) return;

	const [compiledPropertyValues, formattedNoteName, formattedPath, formattedContent] = await Promise.all([
		Promise.all(template.properties.map(property =>
			memoizedCompileTemplate(tabId, unescapeValue(property.value), variables, currentUrl)
		)),
		memoizedCompileTemplate(tabId, template.noteNameFormat, variables, currentUrl),
		memoizedCompileTemplate(tabId, template.path, variables, currentUrl),
		template.noteContentFormat
			? memoizedCompileTemplate(tabId, template.noteContentFormat, variables, currentUrl)
			: Promise.resolve('')
	]);

	for (let i = 0; i < template.properties.length; i++) {
		const property = template.properties[i];
		const inputElement = document.getElementById(property.name) as HTMLInputElement;
		if (!inputElement) continue;

		let value = compiledPropertyValues[i];
		const propertyType = inputElement.getAttribute('data-type') || 'text';
		value = formatPropertyValue(value, propertyType, property.value);

		if (propertyType === 'checkbox') {
			inputElement.checked = value === 'true';
		} else {
			inputElement.value = value;
		}
	}

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.value = formattedNoteName.trim();
		adjustNoteNameHeight(noteNameField);
	}

	const pathField = document.getElementById('path-name-field') as HTMLInputElement;
	if (pathField) {
		pathField.value = formattedPath;
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	if (noteContentField) {
		noteContentField.value = template.noteContentFormat ? formattedContent : '';
	}

	debugLog('Variables', 'Rendered template for:', template.name);
}

function setupMetadataToggle() {
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;

	if (metadataHeader && metadataProperties) {
		metadataHeader.removeEventListener('click', toggleMetadataProperties);
		metadataHeader.addEventListener('click', toggleMetadataProperties);

		getLocalStorage('propertiesCollapsed').then((isCollapsed) => {
			updateMetadataToggleState(isCollapsed === undefined ? false : Boolean(isCollapsed));
		});
	}
}

function toggleMetadataProperties() {
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;

	if (metadataProperties && metadataHeader) {
		const isCollapsed = metadataProperties.classList.toggle('collapsed');
		metadataHeader.classList.toggle('collapsed');
		setLocalStorage('propertiesCollapsed', isCollapsed);
	}
}

function updateMetadataToggleState(isCollapsed: boolean) {
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;

	if (metadataProperties && metadataHeader) {
		if (isCollapsed) {
			metadataProperties.classList.add('collapsed');
			metadataHeader.classList.add('collapsed');
		} else {
			metadataProperties.classList.remove('collapsed');
			metadataHeader.classList.remove('collapsed');
		}
	}
}

function refreshPopup() {
	window.location.reload();
}

function handleTemplateChange(templateId: string) {
	currentTemplate = templates.find(t => t.id === templateId) || templates[0];
	cachedOrgContent = null;
	refreshFields(currentTabId!, false);
}

export async function copyToClipboard(content: string) {
	try {
		try {
			await navigator.clipboard.writeText(content);
		} catch {
			await browser.runtime.sendMessage({
				action: 'copy-to-clipboard',
				text: content
			});
		}

		const pathField = document.getElementById('path-name-field') as HTMLInputElement;
		const path = pathField?.value || '';

		const tabInfo = await getCurrentTabInfo();
		await incrementStat('copyToClipboard', '', path, tabInfo.url, tabInfo.title);

		const clipButton = document.getElementById('clip-btn');
		if (clipButton) {
			const originalText = clipButton.textContent || getMessage('saveFile');
			clipButton.textContent = getMessage('copied');
			setTimeout(() => {
				clipButton.textContent = originalText;
			}, 1500);
		}
	} catch (error) {
		console.error('Failed to copy to clipboard:', error);
		showError('failedToCopyText');
	}
}

function parseTagsValue(value: string): string[] {
	if (!value) return [];
	return value.split(/[,\s]+/).map(t => t.trim()).filter(Boolean);
}

async function handleSaveToDownloads() {
	try {
		const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
		const pathField = document.getElementById('path-name-field') as HTMLInputElement;
		const title = noteNameField?.value || 'untitled';
		const path = pathField?.value || '';

		const properties = getPropertiesFromDOM();
		const tagsProp = properties.find(p => p.name.toLowerCase() === 'tags');
		const tags = parseTagsValue(tagsProp?.value || '');

		const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
		const frontmatter = generateOrgMeta(properties);
		const fileContent = frontmatter + noteContentField.value;

		const fileName = denoteFilename({ title, tags, date: new Date() });

		await saveFile({
			content: fileContent,
			fileName,
			mimeType: 'text/plain',
			tabId: currentTabId,
			onError: () => showError('failedToSaveFile')
		});

		const tabInfo = await getCurrentTabInfo();
		await incrementStat('saveFile', '', path, tabInfo.url, tabInfo.title);

		const moreDropdown = document.getElementById('more-dropdown');
		if (moreDropdown) {
			moreDropdown.classList.remove('show');
		}
	} catch (error) {
		console.error('Failed to save file:', error);
		showError('failedToSaveFile');
	}
}

function determineMainAction() {
	const mainButton = document.getElementById('clip-btn');
	const moreDropdown = document.getElementById('more-dropdown');
	const secondaryActions = moreDropdown?.querySelector('.secondary-actions');
	if (!mainButton || !secondaryActions) return;

	secondaryActions.textContent = '';

	if (loadedSettings.saveBehavior === 'copyToClipboard') {
		mainButton.textContent = getMessage('copyToClipboard');
		mainButton.onclick = () => copyContent();
		addSecondaryAction(secondaryActions, 'saveFile', handleSaveToDownloads);
	} else {
		mainButton.textContent = getMessage('saveFile');
		mainButton.onclick = () => handleSaveToDownloads();
		addSecondaryAction(secondaryActions, 'copyToClipboard', copyContent);
	}
}

function addSecondaryAction(container: Element, actionType: string, handler: () => void) {
	const menuItem = document.createElement('div');
	menuItem.className = 'menu-item';

	const menuItemIcon = document.createElement('div');
	menuItemIcon.className = 'menu-item-icon';

	const iconElement = document.createElement('i');
	iconElement.setAttribute('data-lucide', getActionIcon(actionType));
	menuItemIcon.appendChild(iconElement);

	const menuItemTitle = document.createElement('div');
	menuItemTitle.className = 'menu-item-title';
	menuItemTitle.setAttribute('data-i18n', actionType);
	menuItemTitle.textContent = getMessage(actionType);

	menuItem.appendChild(menuItemIcon);
	menuItem.appendChild(menuItemTitle);

	menuItem.addEventListener('click', handler);
	container.appendChild(menuItem);
	initializeIcons(menuItem);
}

function getActionIcon(actionType: string): string {
	switch (actionType) {
		case 'copyToClipboard': return 'copy';
		case 'saveFile': return 'file-down';
		default: return 'plus';
	}
}

async function copyContent() {
	const properties = getPropertiesFromDOM();
	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	const frontmatter = generateOrgMeta(properties);
	const fileContent = frontmatter + noteContentField.value;
	await copyToClipboard(fileContent);
}

window.addEventListener('resize', debouncedSetPopupDimensions);
