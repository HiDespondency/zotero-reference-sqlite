'use strict';

const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { shell } = require('electron');
const {
	ItemView,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	EditorSuggest,
	Modal,
	debounce
} = require('obsidian');
const { RangeSetBuilder } = require('@codemirror/state');
const { Decoration, ViewPlugin, WidgetType } = require('@codemirror/view');

const execFileAsync = promisify(execFile);
const VIEW_TYPE = 'zotero-reference-sqlite-view';
const CITE_PATTERN = /\[@([A-Za-zА-Яа-яЁё0-9:.#$%&\-+?<>~_/]+)\]/g;
const LOCAL_ZOTERO_API_BASE = 'http://127.0.0.1:23119';
const LOCAL_ZOTERO_API_TIMEOUT_MS = 1000;
const LOCAL_ZOTERO_API_RETRY_AFTER_MS = 30000;
const WINDOWS_SQLITE_SCRIPT = 'zotero_windows_sqlite.ps1';
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const MAX_ZOTERO_DB_BYTES = 1024 * 1024 * 1024;

const DEFAULT_SETTINGS = {
	zoteroDir: '',
	zoteroDbPath: '',
	autoOpenPane: true,
	suggestionLimit: 20,
	recentCitekeys: [],
	recentLimit: 50
};

function normalizeInitials(text) {
	const value = cleanText(text);
	if (!value) return '';
	if (value.includes('.')) {
		const letters = value.match(/[A-Za-zА-Яа-яЁё]/g);
		return letters && letters.length ? `${letters.map((letter) => letter.toUpperCase()).join('.')}.` : value;
	}
	const parts = value.split(/[\s-]+/).filter(Boolean);
	if (parts.length === 0) return value;
	return `${parts.map((part) => part[0].toUpperCase()).join('.')}.`;
}

function isLikelyRussianPatronymic(value) {
	return /(вич|ич|вна|чна|инична|ична)$/i.test(cleanText(value));
}

function splitMisplacedRussianName(firstName, lastName) {
	const firstParts = cleanText(firstName).split(/\s+/).filter(Boolean);
	const last = cleanText(lastName);
	if (firstParts.length < 2 || !isLikelyRussianPatronymic(last)) return null;
	return {
		lastName: firstParts[0],
		firstName: [...firstParts.slice(1), last].join(' ')
	};
}

function cleanText(value) {
	return String(value || '').replace(/\s+/g, ' ').trim();
}

function isSafeExternalUrl(value) {
	try {
		const url = new URL(String(value || ''));
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch (error) {
		return false;
	}
}

function withPeriod(value) {
	const text = cleanText(value);
	if (!text) return '';
	return /[.!?]$/.test(text) ? text : `${text}.`;
}

function normalizePages(value) {
	return cleanText(value).replace(/-/g, '–');
}

function joinParts(parts) {
	return parts.filter(Boolean).join(' ').trim();
}

function citationKeyFromData(data) {
	if (!data) return '';
	if (data.citationKey) return cleanText(data.citationKey);
	const extra = String(data.extra || '');
	const match = extra.match(/(?:Citation Key|citationKey|bibtex):\s*([^\s]+)/i);
	return match ? cleanText(match[1]) : '';
}

function authorsFromCreators(creators) {
	return (creators || [])
		.filter((creator) => ['author', 'editor', 'contributor'].includes(creator.creatorType || 'author'))
		.map((creator, index) => ({
			order: index,
			first_name: creator.firstName || '',
			last_name: creator.lastName || creator.name || ''
		}))
		.filter((author) => author.first_name || author.last_name);
}

function buildAuthorNames(rawAuthors) {
	const authors = [];
	for (const author of rawAuthors || []) {
		let firstName = cleanText(author.first_name);
		let lastName = cleanText(author.last_name);
		const repaired = splitMisplacedRussianName(firstName, lastName);
		if (repaired) {
			firstName = repaired.firstName;
			lastName = repaired.lastName;
		}
		if (firstName && lastName) authors.push(`${lastName} ${normalizeInitials(firstName)}`.trim());
		else if (lastName) authors.push(lastName);
		else if (firstName) authors.push(firstName);
	}
	return authors;
}

function fieldsFromData(data) {
	return {
		title: data.title || '',
		shortTitle: data.shortTitle || '',
		date: data.date || '',
		publicationTitle: data.publicationTitle || data.proceedingsTitle || data.websiteTitle || '',
		pages: data.pages || '',
		publisher: data.publisher || '',
		url: data.url || '',
		abstractNote: data.abstractNote || '',
		volume: data.volume || '',
		issue: data.issue || ''
	};
}

function formatReference(itemType, authors, fields) {
	const authorText = authors.join(', ');
	const title = cleanText(fields.title || fields.shortTitle);
	const journal = cleanText(fields.publicationTitle);
	const year = yearFromDate(fields.date);
	const issue = cleanText(fields.issue);
	const volume = cleanText(fields.volume);
	const pages = normalizePages(fields.pages);
	const url = cleanText(fields.url);
	const parts = [];
	if (authorText) parts.push(withPeriod(authorText));
	if (title) parts.push(journal || url ? `${title} //` : withPeriod(title));
	if (journal) parts.push(withPeriod(journal));
	if (year) parts.push(withPeriod(year));
	if (issue && volume) parts.push(withPeriod(`№ ${issue} (${volume})`));
	else if (issue) parts.push(withPeriod(`№ ${issue}`));
	else if (volume) parts.push(withPeriod(`Т. ${volume}`));
	if (pages) parts.push(withPeriod(`С. ${pages}`));
	if (!journal && url) parts.push(`URL: ${url}`);
	return joinParts(parts);
}

function collectCitationOrder(text) {
	const order = new Map();
	let match;
	while ((match = CITE_PATTERN.exec(text)) !== null) {
		const citekey = match[1];
		if (!order.has(citekey)) {
			order.set(citekey, order.size + 1);
		}
	}
	CITE_PATTERN.lastIndex = 0;
	return order;
}

function extractCitations(text) {
	const order = collectCitationOrder(text);
	const citations = [];
	let match;
	while ((match = CITE_PATTERN.exec(text)) !== null) {
		citations.push({
			from: match.index,
			to: match.index + match[0].length,
			citekey: match[1],
			number: order.get(match[1])
		});
	}
	CITE_PATTERN.lastIndex = 0;
	return citations;
}

function yearFromDate(dateText) {
	if (!dateText) return '';
	const match = String(dateText).match(/\b(19|20)\d{2}\b/);
	return match ? match[0] : String(dateText);
}

function shortAuthorLabel(item) {
	if (!item.authors || item.authors.length === 0) return 'Без автора';
	const first = item.authors[0];
	let firstName = cleanText(first.first_name);
	let lastName = cleanText(first.last_name);
	const repaired = splitMisplacedRussianName(firstName, lastName);
	if (repaired) {
		firstName = repaired.firstName;
		lastName = repaired.lastName;
	}
	const initials = normalizeInitials(firstName);
	return initials ? `${lastName} ${initials}` : lastName;
}

function itemSummary(item) {
	const parts = [];
	const author = shortAuthorLabel(item);
	if (author) parts.push(author);
	const year = yearFromDate(item.date);
	if (year) parts.push(year);
	if (item.publication) parts.push(item.publication);
	const summary = parts.join(' · ');
	if (item.has_pdf === false) return `${summary} · PDF нет`;
	if (item.pdf_count && item.pdf_count > 1) return `${summary} · PDF: ${item.pdf_count}`;
	return summary;
}

class CitationWidget extends WidgetType {
	constructor(number, citekey) {
		super();
		this.number = number;
		this.citekey = citekey;
	}

	toDOM() {
		const span = document.createElement('span');
		span.className = 'local-zotero-references__inline-cite';
		span.textContent = `[${this.number}]`;
		span.title = this.citekey;
		return span;
	}
}

function buildCitationDecorations(state) {
	const builder = new RangeSetBuilder();
	const citations = extractCitations(state.doc.toString());
	for (const citation of citations) {
		builder.add(
			citation.from,
			citation.to,
			Decoration.replace({
				widget: new CitationWidget(citation.number, citation.citekey)
			})
		);
	}
	return builder.finish();
}

function createCitationExtension() {
	return ViewPlugin.fromClass(
		class {
			constructor(view) {
				this.decorations = buildCitationDecorations(view.state);
			}

			update(update) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildCitationDecorations(update.state);
				}
			}
		},
		{
			decorations: (value) => value.decorations
		}
	);
}

class LocalZoteroReferencesView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return 'Zotero Reference SQLite';
	}

	getIcon() {
		return 'book-open';
	}

	async onOpen() {
		this.contentEl.empty();
		this.contentEl.addClass('local-zotero-references');
		this.renderMessage('Открой заметку с ключами цитирования.');
		setTimeout(() => {
			this.plugin.refreshReferences().catch((error) => console.error(error));
		}, 0);
	}

	renderMessage(message) {
		this.contentEl.empty();
		const box = this.contentEl.createDiv({ cls: 'local-zotero-references__message' });
		box.setText(message);
	}

	renderError(message) {
		this.contentEl.empty();
		const box = this.contentEl.createDiv({ cls: 'local-zotero-references__error' });
		box.setText(message);
	}

	renderResult(file, citekeys, result) {
		this.contentEl.empty();

		const header = this.contentEl.createDiv({ cls: 'local-zotero-references__header' });
		header.createDiv({ cls: 'local-zotero-references__title', text: 'Zotero Reference SQLite' });
		header.createDiv({
			cls: 'local-zotero-references__meta',
			text: `${file.basename} · ключей: ${citekeys.length} · найдено: ${result.resolved_keys.length}`
		});

		if (result.unresolved_keys && result.unresolved_keys.length > 0) {
			const warning = this.contentEl.createDiv({ cls: 'local-zotero-references__warning' });
			warning.createDiv({ text: 'Не найдены ключи:' });
			const list = warning.createEl('ul', { cls: 'local-zotero-references__plain-list' });
			for (const citekey of result.unresolved_keys) {
				list.createEl('li', { text: citekey });
			}
		}

		if (!result.references || result.references.length === 0) {
			this.contentEl.createDiv({
				cls: 'local-zotero-references__message',
				text: 'В заметке нет найденных источников.'
			});
			return;
		}

		const listWrap = this.contentEl.createDiv({ cls: 'local-zotero-references__list' });
		for (const reference of result.references) {
			const entry = listWrap.createDiv({ cls: 'local-zotero-references__entry' });
			entry.createDiv({
				cls: 'local-zotero-references__entry-text',
				text: `${reference.number}. ${reference.text}`
			});

			const item = result.items[reference.citekey];
			if (!item) continue;

			const actions = entry.createDiv({ cls: 'local-zotero-references__actions' });

			if (item.url) {
				const urlButton = actions.createEl('button', {
					cls: 'local-zotero-references__button',
					text: 'Открыть статью'
				});
				urlButton.addEventListener('click', async () => {
					if (!isSafeExternalUrl(item.url)) {
						new Notice('Заблокирован небезопасный URL источника.');
						return;
					}
					await shell.openExternal(item.url);
				});
			}

			if (item.pdf_paths && item.pdf_paths.length > 0) {
				for (let i = 0; i < item.pdf_paths.length; i += 1) {
					const pdfPath = item.pdf_paths[i];
					const label = item.pdf_paths.length === 1 ? 'Открыть PDF' : `Открыть PDF ${i + 1}`;
					const pdfButton = actions.createEl('button', {
						cls: 'local-zotero-references__button',
						text: label
					});
					pdfButton.addEventListener('click', async () => {
						if (!this.plugin.isSafePdfPath(pdfPath)) {
							new Notice('Заблокирован небезопасный путь к PDF.');
							return;
						}
						const error = await shell.openPath(pdfPath);
						if (error) {
							new Notice(`Не удалось открыть PDF: ${error}`);
						}
					});
				}
			}
		}
	}
}

class ZoteroCitationSuggest extends EditorSuggest {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
	}

	onTrigger(cursor, editor) {
		const line = editor.getLine(cursor.line);
		const beforeCursor = line.slice(0, cursor.ch);
		const match = beforeCursor.match(/\[@([^\]]*)$/);
		if (!match) return null;

		return {
			start: { line: cursor.line, ch: cursor.ch - match[1].length },
			end: cursor,
			query: match[1]
		};
	}

	async getSuggestions(context) {
		const items = await this.plugin.searchZotero(context.query);
		return items.filter((item) => item.citekey);
	}

	renderSuggestion(item, el) {
		el.empty();
		el.createDiv({ text: item.title || `@${item.citekey}` });
		el.createDiv({
			text: itemSummary(item),
			cls: 'mod-muted'
		});
		el.createDiv({
			text: `@${item.citekey}`,
			cls: 'mod-muted'
		});
	}

	selectSuggestion(item, evt) {
		if (!this.context) return;
		const editor = this.context.editor;
		editor.replaceRange(`${item.citekey}]`, this.context.start, this.context.end);
		void this.plugin.handleCitationInserted(item.citekey, editor);
	}
}

class ZoteroCitationModal extends Modal {
	constructor(app, plugin, editor) {
		super(app);
		this.plugin = plugin;
		this.editor = editor;
		this.items = [];
		this.selectedIndex = 0;
		this.pendingToken = 0;
	}

	onOpen() {
		this.setTitle('Вставить источник Zotero SQLite');
		const { contentEl } = this;
		contentEl.empty();

		this.inputEl = contentEl.createEl('input', {
			type: 'text',
			placeholder: 'Начни вводить автора, название или год'
		});
		this.inputEl.addClass('prompt-input');

		this.counterEl = contentEl.createDiv({ text: 'Найдено работ: 0' });
		this.counterEl.style.marginTop = '12px';
		this.counterEl.style.fontWeight = '600';
		this.listEl = contentEl.createDiv();
		this.listEl.style.marginTop = '12px';
		this.helpEl = contentEl.createDiv({ text: 'Enter — вставить первую найденную работу.' });
		this.helpEl.style.marginTop = '12px';
		this.helpEl.style.opacity = '0.75';

		contentEl.prepend(this.counterEl);
		contentEl.insertBefore(this.inputEl, this.listEl);

		this.inputEl.addEventListener('input', () => {
			this.refresh(this.inputEl.value);
		});
		this.inputEl.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter') {
				evt.preventDefault();
				if (this.items[0]) {
					this.insertItem(this.items[0]);
				}
			}
		});

		this.refresh('');
		window.setTimeout(() => this.inputEl.focus(), 50);
	}

	renderList() {
		this.listEl.empty();
		this.counterEl.setText(`Найдено работ: ${this.items.length}`);
		if (this.items.length === 0) {
			this.listEl.createDiv({ text: 'Ничего не найдено.' });
			return;
		}

		for (const item of this.items) {
			const row = this.listEl.createDiv();
			row.style.padding = '8px 10px';
			row.style.border = '1px solid var(--background-modifier-border)';
			row.style.borderRadius = '8px';
			row.style.marginBottom = '8px';
			row.style.cursor = 'pointer';

			row.createDiv({ text: item.title || `@${item.citekey}` });
			const meta = row.createDiv({ text: itemSummary(item) });
			meta.style.opacity = '0.75';
			meta.style.fontSize = '0.9em';
			const cite = row.createDiv({ text: `@${item.citekey}` });
			cite.style.opacity = '0.65';
			cite.style.fontSize = '0.85em';

			row.addEventListener('click', () => this.insertItem(item));
		}
	}

	async refresh(query) {
		const token = ++this.pendingToken;
		try {
			const items = await this.plugin.searchZotero(query);
			if (token !== this.pendingToken) return;
			this.items = items.filter((item) => item.citekey);
			this.renderList();
		} catch (error) {
			if (token !== this.pendingToken) return;
			this.items = [];
			this.listEl.empty();
			this.listEl.createDiv({ text: `Ошибка поиска: ${error.message}` });
		}
	}

	insertItem(item) {
		const editor = this.editor;
		editor.replaceSelection(`[@${item.citekey}]`);
		void this.plugin.handleCitationInserted(item.citekey, editor);
		this.close();
	}
}

class LocalZoteroReferencesSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Папка Zotero')
			.setDesc('Необязательно. Если Zotero закрыт, плагин безопасно читает локальный zotero.sqlite из этой папки.')
			.addText((text) =>
				text.setPlaceholder('C:\\Users\\Имя\\Zotero').setValue(this.plugin.settings.zoteroDir).onChange(async (value) => {
					this.plugin.settings.zoteroDir = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Путь к базе Zotero')
			.setDesc('Необязательно. Если указан, плагин будет брать именно эту базу zotero.sqlite, даже если папка Zotero лежит в другом месте.')
			.addText((text) =>
				text.setPlaceholder('C:\\Users\\Имя\\Zotero\\zotero.sqlite').setValue(this.plugin.settings.zoteroDbPath).onChange(async (value) => {
					this.plugin.settings.zoteroDbPath = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Подсказок за раз')
			.setDesc('Сколько результатов показывать в подсказке и окне поиска.')
			.addText((text) =>
				text.setPlaceholder('20').setValue(String(this.plugin.settings.suggestionLimit)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					this.plugin.settings.suggestionLimit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 50) : 20;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Открывать панель автоматически')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoOpenPane).onChange(async (value) => {
					this.plugin.settings.autoOpenPane = value;
					await this.plugin.saveSettings();
				})
			);
	}
}

class LocalZoteroReferencesPlugin extends Plugin {
	async onload() {
		await this.loadSettings();
		this.lastMarkdownFile = null;
		this.localZoteroApiDisabledUntil = 0;

		this.registerView(VIEW_TYPE, (leaf) => new LocalZoteroReferencesView(leaf, this));
		this.addSettingTab(new LocalZoteroReferencesSettingTab(this.app, this));
		this.registerEditorExtension(createCitationExtension());
		this.registerEditorSuggest(new ZoteroCitationSuggest(this.app, this));
		this.registerMarkdownPostProcessor(async (el, context) => {
			await this.replaceRenderedCitations(el, context);
		});

		this.addCommand({
			id: 'open-zotero-reference-sqlite',
			name: 'Открыть панель Zotero Reference SQLite',
			callback: async () => {
				await this.ensureView();
				await this.refreshReferences();
			}
		});

		this.addCommand({
			id: 'insert-zotero-reference-sqlite-citation',
			name: 'Вставить ключ Zotero SQLite через поиск',
			editorCallback: (editor) => {
				new ZoteroCitationModal(this.app, this, editor).open();
			}
		});

		this.addCommand({
			id: 'check-zotero-reference-sqlite-source',
			name: 'Проверить подключение Zotero Reference SQLite',
			callback: async () => {
				try {
					this.localZoteroApiDisabledUntil = 0;
					const items = await this.searchZotero('');
					const count = Array.isArray(items) ? items.length : 0;
					new Notice(`Zotero подключён. Найдено записей в быстрой проверке: ${count}`);
				} catch (error) {
					new Notice(`Zotero не найден: ${error.message}`);
				}
			}
		});

		this.refreshDebounced = debounce((editor) => {
			this.refreshReferences({ editor }).catch((error) => console.error(error));
		}, 150, true);

		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			this.rememberMarkdownFile(file);
			this.refreshDebounced();
		}));
		this.registerEvent(this.app.workspace.on('editor-change', (editor) => this.refreshDebounced(editor)));

		this.app.workspace.onLayoutReady(async () => {
			if (this.settings.autoOpenPane) {
				await this.ensureView();
			}
			await this.refreshReferences();
		});
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async noteCitationUsed(citekey) {
		if (!citekey) return;
		const current = Array.isArray(this.settings.recentCitekeys) ? this.settings.recentCitekeys : [];
		const next = [citekey, ...current.filter((key) => key !== citekey)].slice(0, this.settings.recentLimit || 50);
		this.settings.recentCitekeys = next;
		await this.saveSettings();
	}

	async handleCitationInserted(citekey, editor) {
		this.rememberActiveMarkdownFile();
		await this.noteCitationUsed(citekey);
		setTimeout(() => {
			this.refreshReferences({ editor }).catch((error) => console.error(error));
		}, 0);
	}

	sortByRecentUsage(items) {
		const recent = Array.isArray(this.settings.recentCitekeys) ? this.settings.recentCitekeys : [];
		if (recent.length === 0) return items;
		const rank = new Map(recent.map((citekey, index) => [citekey, index]));
		return [...items].sort((a, b) => {
			const aRank = rank.has(a.citekey) ? rank.get(a.citekey) : Number.MAX_SAFE_INTEGER;
			const bRank = rank.has(b.citekey) ? rank.get(b.citekey) : Number.MAX_SAFE_INTEGER;
			if (aRank !== bRank) return aRank - bRank;
			return 0;
		});
	}

	async fetchLocalZoteroApi(pathname, params = {}) {
		if (Date.now() < this.localZoteroApiDisabledUntil) {
			throw new Error('Локальный API Zotero временно пропущен после неудачной проверки.');
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), LOCAL_ZOTERO_API_TIMEOUT_MS);
		try {
			const url = new URL(`${LOCAL_ZOTERO_API_BASE}${pathname}`);
			if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') {
				throw new Error('Разрешён только локальный API Zotero на 127.0.0.1.');
			}
			for (const [key, value] of Object.entries(params)) {
				if (value !== undefined && value !== null && value !== '') {
					url.searchParams.set(key, String(value));
				}
			}
			const response = await fetch(url.toString(), {
				headers: { 'Zotero-API-Version': '3' },
				signal: controller.signal
			});
			if (!response.ok) throw new Error(`Zotero API ${response.status}`);
			return response.json();
		} catch (error) {
			this.localZoteroApiDisabledUntil = Date.now() + LOCAL_ZOTERO_API_RETRY_AFTER_MS;
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	async fetchZoteroChildrenApi(itemKey) {
		if (!/^[A-Za-z0-9]+$/.test(String(itemKey || ''))) return [];
		try {
			return await this.fetchLocalZoteroApi(`/api/users/0/items/${encodeURIComponent(itemKey)}/children`, {
				format: 'json',
				include: 'data',
				limit: 100
			});
		} catch (error) {
			console.warn(`Не удалось получить вложения Zotero через API: ${error.message}`);
			return [];
		}
	}

	resolveApiFileHref(href) {
		if (!href || !String(href).startsWith('file:')) return '';
		try {
			const filePath = fileURLToPath(href);
			return this.isSafePdfPath(filePath) ? filePath : '';
		} catch (error) {
			return '';
		}
	}

	resolveApiAttachmentPath(attachmentData, enclosureHref = '') {
		const rawPath = cleanText(attachmentData.path);
		if (!rawPath) return this.resolveApiFileHref(enclosureHref);
		if ((/^[A-Za-z]:\\/.test(rawPath) || rawPath.startsWith('/')) && this.isSafePdfPath(rawPath)) {
			return rawPath;
		}
		if (!rawPath.startsWith('storage:')) return this.resolveApiFileHref(enclosureHref);
		const relativeName = rawPath.slice('storage:'.length);
		if (!relativeName || relativeName.includes('..') || /[\\/]/.test(relativeName)) return '';
		const attachmentKey = cleanText(attachmentData.key);
		if (!/^[A-Za-z0-9]+$/.test(attachmentKey)) return '';
		for (const storageRoot of this.getAllowedPdfRoots()) {
			const candidate = path.join(storageRoot, attachmentKey, relativeName);
			if (this.isSafePdfPath(candidate)) return candidate;
		}
		return '';
	}

	async attachmentsFromApiItem(item) {
		const children = await this.fetchZoteroChildrenApi(item.key);
		const attachments = [];
		for (const child of children) {
			const data = child.data || child;
			if (data.itemType !== 'attachment') continue;
			const contentType = data.contentType || '';
			const enclosureHref = child.links && child.links.enclosure && child.links.enclosure.href;
			const pdfPath = contentType === 'application/pdf' ? this.resolveApiAttachmentPath(data, enclosureHref) : '';
			attachments.push({
				item_id: data.key || '',
				key: data.key || '',
				title: data.title || '',
				content_type: contentType,
				path: pdfPath
			});
		}
		return attachments;
	}

	async buildApiItem(rawItem, options = {}) {
		const data = rawItem.data || rawItem;
		const fields = fieldsFromData(data);
		const rawAuthors = authorsFromCreators(data.creators);
		const citekey = citationKeyFromData(data);
		const attachments = options.includeAttachments ? await this.attachmentsFromApiItem(rawItem) : [];
		const pdfPaths = attachments
			.filter((attachment) => attachment.content_type === 'application/pdf' && attachment.path)
			.map((attachment) => attachment.path);
		const authors = buildAuthorNames(rawAuthors);
		return {
			item_id: data.key || rawItem.key || '',
			key: data.key || rawItem.key || '',
			citekey,
			title: fields.title,
			date: fields.date,
			publication: fields.publicationTitle,
			url: fields.url,
			authors: rawAuthors,
			has_pdf: pdfPaths.length > 0,
			pdf_count: pdfPaths.length,
			pdf_paths: pdfPaths,
			item_type: data.itemType || '',
			formatted_reference: formatReference(data.itemType || '', authors, fields)
		};
	}

	async searchZoteroApi(query) {
		const limit = Math.min(Math.max(this.settings.suggestionLimit || 20, 1), 50);
		const rawItems = await this.fetchLocalZoteroApi('/api/users/0/items', {
			format: 'json',
			include: 'data',
			itemType: '-attachment',
			q: query || undefined,
			qmode: query ? 'everything' : undefined,
			sort: query ? undefined : 'dateModified',
			direction: 'desc',
			limit: Math.max(limit * 3, 30)
		});
		const items = [];
		for (const rawItem of rawItems) {
			const item = await this.buildApiItem(rawItem, { includeAttachments: true });
			if (!item.citekey || !item.has_pdf) continue;
			items.push(item);
			if (items.length >= limit) break;
		}
		return this.sortByRecentUsage(items);
	}

	async findZoteroApiItemByCitekey(citekey) {
		const rawItems = await this.fetchLocalZoteroApi('/api/users/0/items', {
			format: 'json',
			include: 'data',
			itemType: '-attachment',
			q: citekey,
			qmode: 'everything',
			limit: 50
		});
		for (const rawItem of rawItems) {
			const data = rawItem.data || rawItem;
			if (citationKeyFromData(data) !== citekey) continue;
			const item = await this.buildApiItem(rawItem, { includeAttachments: true });
			return item.citekey ? item : null;
		}
		return null;
	}

	async callReferenceApi(citekeys) {
		const items = {};
		const references = [];
		const resolvedKeys = [];
		const unresolvedKeys = [];
		for (let index = 0; index < citekeys.length; index += 1) {
			const citekey = citekeys[index];
			const item = await this.findZoteroApiItemByCitekey(citekey);
			if (!item) {
				unresolvedKeys.push(citekey);
				continue;
			}
			items[citekey] = item;
			resolvedKeys.push(citekey);
			references.push({
				citekey,
				number: references.length + 1,
				text: item.formatted_reference
			});
		}
		return {
			source: 'api',
			zotero_dir: '',
			db_path: '',
			resolved_keys: resolvedKeys,
			unresolved_keys: unresolvedKeys,
			duplicate_keys: {},
			items,
			references
		};
	}

	resolveVaultPath(inputPath) {
		if (!inputPath) return '';
		if (/^[A-Za-z]:\\/.test(inputPath) || inputPath.startsWith('/') || inputPath.startsWith('\\\\')) {
			return inputPath;
		}
		return path.join(this.app.vault.adapter.basePath, inputPath);
	}

	isUncPath(inputPath) {
		return String(inputPath || '').startsWith('\\\\');
	}

	realPath(inputPath) {
		return fs.realpathSync.native ? fs.realpathSync.native(inputPath) : fs.realpathSync(inputPath);
	}

	assertSafeConfiguredZoteroDir(inputPath) {
		if (!inputPath) return '';
		const resolved = this.resolveVaultPath(inputPath);
		if (this.isUncPath(resolved)) throw new Error('Сетевые UNC-пути Zotero отключены в безопасном режиме.');
		const linkInfo = fs.lstatSync(resolved);
		if (linkInfo.isSymbolicLink()) throw new Error('Символические ссылки на папку Zotero отключены в безопасном режиме.');
		const realPath = this.realPath(resolved);
		if (!fs.statSync(realPath).isDirectory()) {
			throw new Error(`Папка Zotero не найдена: ${resolved}`);
		}
		return realPath;
	}

	assertSafeConfiguredZoteroDb(inputPath) {
		if (!inputPath) return '';
		const resolved = this.resolveVaultPath(inputPath);
		if (this.isUncPath(resolved)) throw new Error('Сетевые UNC-пути к базе Zotero отключены в безопасном режиме.');
		const linkInfo = fs.lstatSync(resolved);
		if (linkInfo.isSymbolicLink()) throw new Error('Символические ссылки на базу Zotero отключены в безопасном режиме.');
		const realPath = this.realPath(resolved);
		if (path.basename(realPath).toLowerCase() !== 'zotero.sqlite') throw new Error('Путь к базе должен указывать на файл zotero.sqlite.');
		const stats = fs.statSync(realPath);
		if (!stats.isFile()) {
			throw new Error(`База Zotero не найдена: ${resolved}`);
		}
		if (stats.size > MAX_ZOTERO_DB_BYTES) throw new Error('База Zotero слишком большая для безопасного чтения.');
		return realPath;
	}

	resolveWindowsSqliteScriptPath() {
		return path.join(this.manifest.dir, WINDOWS_SQLITE_SCRIPT);
	}

	resolvePowershellPath() {
		if (!fs.existsSync(POWERSHELL_EXE)) throw new Error('Системный Windows PowerShell не найден.');
		return POWERSHELL_EXE;
	}

	normalizePathForCompare(inputPath) {
		return path.resolve(inputPath).toLowerCase();
	}

	isPathInside(childPath, parentPath) {
		const child = this.normalizePathForCompare(childPath);
		const parent = this.normalizePathForCompare(parentPath);
		return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
	}

	getAllowedPdfRoots() {
		const roots = [];
		try {
			const zoteroDir = this.assertSafeConfiguredZoteroDir(this.settings.zoteroDir);
			if (zoteroDir) roots.push(path.join(zoteroDir, 'storage'));
		} catch (error) {
			console.warn(error);
		}
		try {
			const zoteroDbPath = this.assertSafeConfiguredZoteroDb(this.settings.zoteroDbPath);
			if (zoteroDbPath) roots.push(path.join(path.dirname(zoteroDbPath), 'storage'));
		} catch (error) {
			console.warn(error);
		}
		roots.push(path.join(this.app.vault.adapter.basePath, 'Zotero', 'storage'));
		roots.push(path.join(require('os').homedir(), 'Zotero', 'storage'));
		return [...new Set(roots.map((root) => {
			try {
				if (this.isUncPath(root)) return '';
				const linkInfo = fs.lstatSync(root);
				if (linkInfo.isSymbolicLink() || !linkInfo.isDirectory()) return '';
				return this.realPath(root);
			} catch (error) {
				return '';
			}
		}).filter(Boolean))];
	}

	isSafePdfPath(pdfPath) {
		if (!pdfPath || path.extname(pdfPath).toLowerCase() !== '.pdf') return false;
		try {
			const resolved = path.resolve(pdfPath);
			if (this.isUncPath(resolved)) return false;
			const linkInfo = fs.lstatSync(resolved);
			if (linkInfo.isSymbolicLink()) return false;
			const realPath = this.realPath(resolved);
			if (path.extname(realPath).toLowerCase() !== '.pdf') return false;
			if (!fs.statSync(realPath).isFile()) return false;
			return this.getAllowedPdfRoots().some((root) => this.isPathInside(realPath, root));
		} catch (error) {
			return false;
		}
	}

	buildWindowsSourceArgs() {
		const args = [];
		const zoteroDir = this.assertSafeConfiguredZoteroDir(this.settings.zoteroDir);
		const zoteroDbPath = this.assertSafeConfiguredZoteroDb(this.settings.zoteroDbPath);
		if (zoteroDir) {
			args.push('-ZoteroDir', zoteroDir);
		}
		if (zoteroDbPath) {
			args.push('-DbPath', zoteroDbPath);
		}
		return args;
	}

	async callWindowsSqliteReferences(citekeys) {
		const scriptPath = this.resolveWindowsSqliteScriptPath();
		const args = [
			'-NoProfile',
			'-ExecutionPolicy',
			'RemoteSigned',
			'-File',
			scriptPath,
			...this.buildWindowsSourceArgs(),
			'-KeysJson',
			JSON.stringify(citekeys)
		];
		const { stdout, stderr } = await execFileAsync(this.resolvePowershellPath(), args, {
			cwd: this.app.vault.adapter.basePath,
			maxBuffer: 10 * 1024 * 1024,
			timeout: 30000,
			windowsHide: true
		});
		if (stderr && stderr.trim()) console.warn(stderr);
		return JSON.parse(stdout);
	}

	async searchWindowsSqlite(query) {
		const scriptPath = this.resolveWindowsSqliteScriptPath();
		const args = [
			'-NoProfile',
			'-ExecutionPolicy',
			'RemoteSigned',
			'-File',
			scriptPath,
			...this.buildWindowsSourceArgs(),
			'-Text',
			query || '',
			'-Limit',
			String(this.settings.suggestionLimit || 20),
			'-Lite',
			'-RequirePdf'
		];
		const { stdout, stderr } = await execFileAsync(this.resolvePowershellPath(), args, {
			cwd: this.app.vault.adapter.basePath,
			maxBuffer: 10 * 1024 * 1024,
			timeout: 30000,
			windowsHide: true
		});
		if (stderr && stderr.trim()) console.warn(stderr);
		const result = JSON.parse(stdout);
		return this.sortByRecentUsage(result.items || []);
	}

	getActiveMarkdownView() {
		return this.app.workspace.getActiveViewOfType(MarkdownView);
	}

	rememberMarkdownFile(file) {
		if (file && file.extension === 'md') {
			this.lastMarkdownFile = file;
		}
	}

	rememberActiveMarkdownFile() {
		const view = this.getActiveMarkdownView();
		if (view && view.file) {
			this.rememberMarkdownFile(view.file);
			return view.file;
		}

		const activeFile = this.app.workspace.getActiveFile();
		this.rememberMarkdownFile(activeFile);
		return activeFile && activeFile.extension === 'md' ? activeFile : null;
	}

	getActiveMarkdownFile() {
		const activeFile = this.rememberActiveMarkdownFile();
		if (activeFile) return activeFile;

		if (this.lastMarkdownFile && this.lastMarkdownFile.path) {
			const file = this.app.vault.getAbstractFileByPath(this.lastMarkdownFile.path);
			if (file && file.extension === 'md') {
				this.lastMarkdownFile = file;
				return file;
			}
		}

		return null;
	}

	getFileFromEditor(editor) {
		if (!editor) return null;
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.editor === editor && view.file) {
				this.rememberMarkdownFile(view.file);
				return view.file;
			}
		}
		return null;
	}

	async ensureView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) return existing[0];

		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return null;

		await leaf.setViewState({
			type: VIEW_TYPE,
			active: false
		});
		return leaf;
	}

	getView() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		return leaves.length > 0 ? leaves[0].view : null;
	}

	extractCiteKeys(text) {
		return Array.from(collectCitationOrder(text).keys());
	}

	async callReferenceScript(citekeys) {
		let apiResult = null;
		try {
			apiResult = await this.callReferenceApi(citekeys);
			if (apiResult.unresolved_keys.length === 0) return apiResult;
		} catch (error) {
			this.localZoteroApiDisabledUntil = Date.now() + LOCAL_ZOTERO_API_RETRY_AFTER_MS;
			console.warn(`Zotero API недоступен, используется SQLite: ${error.message}`);
		}
		try {
			return await this.callWindowsSqliteReferences(citekeys);
		} catch (error) {
			if (apiResult) return apiResult;
			throw error;
		}
	}

	async searchZotero(query) {
		try {
			const apiItems = await this.searchZoteroApi(query || '');
			if (apiItems.length > 0) return apiItems;
		} catch (error) {
			this.localZoteroApiDisabledUntil = Date.now() + LOCAL_ZOTERO_API_RETRY_AFTER_MS;
			console.warn(`Zotero API недоступен, используется SQLite: ${error.message}`);
		}
		return this.searchWindowsSqlite(query);
	}

	async replaceRenderedCitations(el, context) {
		const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
		if (!file || !file.path) return;

		const content = await this.app.vault.cachedRead(file);
		const citeOrder = collectCitationOrder(content);
		if (citeOrder.size === 0) return;

		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const textNodes = [];
		while (walker.nextNode()) {
			const node = walker.currentNode;
			const parent = node.parentElement;
			if (!parent) continue;
			if (parent.closest('code, pre, .local-zotero-references__list')) continue;
			textNodes.push(node);
		}

		for (const textNode of textNodes) {
			const text = textNode.nodeValue || '';
			if (!text.includes('[@')) continue;

			const fragment = document.createDocumentFragment();
			let lastIndex = 0;
			let changed = false;
			let match;

			while ((match = CITE_PATTERN.exec(text)) !== null) {
				const citekey = match[1];
				const number = citeOrder.get(citekey);
				if (!number) continue;

				changed = true;
				if (match.index > lastIndex) {
					fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
				}

				const span = document.createElement('span');
				span.className = 'local-zotero-references__inline-cite';
				span.textContent = `[${number}]`;
				span.title = citekey;
				fragment.appendChild(span);

				lastIndex = match.index + match[0].length;
			}

			CITE_PATTERN.lastIndex = 0;
			if (!changed) continue;
			if (lastIndex < text.length) {
				fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
			}
			textNode.parentNode.replaceChild(fragment, textNode);
		}
	}

	async refreshReferences(options = {}) {
		const view = this.getView();
		if (!view) return;

		const file = this.getFileFromEditor(options.editor) || this.getActiveMarkdownFile();
		if (!file) {
			view.renderMessage('Открой заметку Markdown.');
			return;
		}

		const content = options.editor ? options.editor.getValue() : await this.app.vault.cachedRead(file);
		const citekeys = this.extractCiteKeys(content);
		if (citekeys.length === 0) {
			view.renderMessage('В текущей заметке нет ключей вида [@ключ].');
			return;
		}

		try {
			view.renderMessage(`Ищу источники Zotero: ключей ${citekeys.length}...`);
			const result = await this.callReferenceScript(citekeys);
			view.renderResult(file, citekeys, result);
		} catch (error) {
			console.error(error);
			view.renderError(`Не удалось собрать список источников: ${error.message}`);
		}
	}
}

module.exports = LocalZoteroReferencesPlugin;
