const appView = document.querySelector("#app-view");
const shelfView = document.querySelector("#shelf-view");
const readerView = document.querySelector("#reader-view");
const bookList = document.querySelector("#book-list");
const libraryCount = document.querySelector("#library-count");
const importInput = document.querySelector("#book-import");
const importMessage = document.querySelector("#import-message");
const readingPage = document.querySelector("#reading-page");
const pageText = document.querySelector("#page-text");
const readerBookTitle = document.querySelector("#reader-book-title");
const readerChapterTitle = document.querySelector("#reader-chapter-title");
const readerMinimalChapter = document.querySelector("#reader-minimal-chapter");
const readerCurrentTime = document.querySelector("#reader-current-time");
const readerPageStatus = document.querySelector("#reader-page-status");
const progressBar = document.querySelector("#progress-bar");
const progressText = document.querySelector("#progress-text");
const tocPanel = document.querySelector("#toc-panel");
const tocList = document.querySelector("#toc-list");
const settingsPanel = document.querySelector("#settings-panel");
const fontSizeLabel = document.querySelector("#font-size-label");

const DB_NAME = "devmark-reader";
const DB_VERSION = 1;
const STATE_KEY = "reader-state";
const DEFAULT_STATE = {
  settings: { fontWeight: 400, fontSize: 21, lineHeight: 1.95, theme: "paper" },
  progress: {}
};
// 每次调整目录识别时递增；已导入的书会在首次打开时自动重建目录。
const CHAPTER_PARSER_VERSION = 2;
const TEXT_NORMALIZATION_VERSION = 1;
const THEME_COLORS = {
  paper: "#f6f1e7",
  sepia: "#eee0bf",
  night: "#202321"
};
const MARKDOWN_HEADING_PATTERN = /^[\t \u3000]*#{1,6}[\t \u3000]+(.{1,120}?)[\t \u3000]*$/gm;
const PLAIN_CHAPTER_PATTERN = /^[\t \u3000]*(第[0-9零一二三四五六七八九十百千万两]+[章节卷回].{0,80}|(?:楔子|序章|终章|番外|后记|完本感言).{0,80})[\t \u3000]*$/gm;

let databasePromise;
let state = structuredClone(DEFAULT_STATE);
let books = [];
let currentBook = null;
let pages = [];
let chapters = [];
let currentChapterIndex = 0;
let currentPage = 0;
let pointerStart = null;
let suppressPageClick = false;
let resizeTimer = null;

function updateReaderClock() {
  readerCurrentTime.textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("books")) database.createObjectStore("books", { keyPath: "id" });
      if (!database.objectStoreNames.contains("state")) database.createObjectStore("state", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

async function readStore(storeName, key) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readAll(storeName) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function writeStore(storeName, value) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readwrite").objectStore(storeName).put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function removeStore(storeName, key) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readwrite").objectStore(storeName).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function normalizeState(value) {
  return {
    settings: { ...DEFAULT_STATE.settings, ...(value?.settings || {}) },
    progress: value?.progress || {}
  };
}

async function loadState() {
  const stored = await readStore("state", STATE_KEY);
  state = normalizeState(stored?.value);
}

function saveState() {
  return writeStore("state", { key: STATE_KEY, value: state });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function formatBytes(size) {
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function frame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeReadingText(content) {
  return content
    .replace(/\r/g, "")
    .replace(/\n[\t \u3000]*\n+/g, "\n");
}

function normalizedOffset(content, offset) {
  const safeOffset = Math.min(Math.max(Number(offset) || 0, 0), content.length);
  return normalizeReadingText(content.slice(0, safeOffset)).length;
}

function applyAppChrome(theme) {
  const color = THEME_COLORS[theme] || THEME_COLORS.paper;
  document.documentElement.style.backgroundColor = color;
  document.documentElement.style.colorScheme = theme === "night" ? "dark" : "light";
  document.body.style.backgroundColor = color;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.setAttribute("content", theme === "night" ? "black" : "default");
}

function makeChapters(content) {
  const text = content.replace(/\r/g, "");
  // 有 Markdown 标题时，只使用它们，避免正文中类似“第一章”的句子被误判。
  const markdownMatches = [...text.matchAll(MARKDOWN_HEADING_PATTERN)];
  const sourceMatches = markdownMatches.length ? markdownMatches : [...text.matchAll(PLAIN_CHAPTER_PATTERN)];
  const matches = sourceMatches.map((match) => ({ title: match[1].trim(), start: match.index }));
  const made = [];
  if (matches.length && matches[0].start > 0) made.push({ title: "开始阅读", start: 0 });
  matches.forEach((match) => made.push(match));
  if (!made.length) made.push({ title: "开始阅读", start: 0 });
  return made.map((chapter, index) => ({
    ...chapter,
    index,
    end: made[index + 1]?.start ?? text.length
  }));
}

function bookMetadata(file, content) {
  const lines = content.slice(0, 5000).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = lines.find((line) => !/^作者[：:]/.test(line) && !/^简介[：:]?/.test(line)) || file.name.replace(/\.txt$/i, "");
  const author = lines.find((line) => /^作者[：:]/.test(line))?.replace(/^作者[：:]\s*/, "") || "本地导入";
  return { title: title.replace(/[《》]/g, ""), author };
}

function bookProgress(book) {
  const percent = state.progress[book.id]?.percent || 0;
  return percent > 0 ? `已读 ${percent}%` : "尚未开始";
}

async function refreshBooks() {
  books = (await readAll("books")).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  libraryCount.textContent = `${books.length} 本藏书`;
  if (!books.length) {
    bookList.innerHTML = '<p class="empty-note">书架还是空的。点击“导入 TXT”，从 iPhone 文件 App 选择小说；导入后会保存在这台手机，断网也能看。</p>';
    return;
  }
  bookList.innerHTML = books.map((book) => `
    <article class="book-card">
      <div class="book-cover"><span class="cover-label">ON THIS DEVICE · TXT</span><strong class="cover-title">${escapeHtml(book.title)}</strong></div>
      <div class="book-info">
        <p class="book-meta">${escapeHtml(book.author)} · ${formatBytes(book.size)}</p>
        <h4>${escapeHtml(book.title)}</h4>
        <p class="progress-note">${bookProgress(book)}</p>
        <div class="book-actions"><button class="open-book" data-open-book="${book.id}">${state.progress[book.id]?.percent ? "继续阅读" : "开始阅读"}</button><button class="delete-book" data-delete-book="${book.id}">删除</button></div>
      </div>
    </article>`).join("");
}

function createPages(content) {
  const text = content.replace(/\r/g, "").replace(/[\s\u200B\uFEFF]+$/u, "");
  const probe = document.createElement("div");
  const computed = getComputedStyle(pageText);
  const fontSize = Number.parseFloat(computed.fontSize) || state.settings.fontSize;
  const lineHeight = Number.parseFloat(computed.lineHeight) || fontSize * state.settings.lineHeight;
  const estimatedCapacity = Math.max(80, Math.floor((pageText.clientWidth / (fontSize * 1.03)) * (pageText.clientHeight / lineHeight)));
  ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "word-spacing", "white-space", "word-break", "overflow-wrap", "text-align", "text-indent", "direction"].forEach((property) => {
    probe.style.setProperty(property, computed.getPropertyValue(property));
  });
  probe.className = "pagination-probe";
  probe.style.width = `${pageText.clientWidth}px`;
  probe.style.height = `${pageText.clientHeight}px`;
  document.body.append(probe);

  const fits = (start, end) => {
    probe.textContent = text.slice(start, end);
    return probe.scrollHeight <= probe.clientHeight + 1;
  };

  const endForPage = (start) => {
    let low = start;
    let high = Math.min(text.length, start + estimatedCapacity);
    if (fits(start, high)) {
      low = high;
      while (low < text.length) {
        high = Math.min(text.length, low + estimatedCapacity);
        if (!fits(start, high)) break;
        low = high;
      }
      if (low === text.length) return low;
    }
    while (low + 1 < high) {
      const middle = low + Math.ceil((high - low) / 2);
      if (fits(start, middle)) low = middle;
      else high = middle - 1;
    }
    return Math.max(start + 1, low);
  };

  const made = [];
  let start = 0;
  try {
    while (start < text.length) {
      const end = endForPage(start);
      made.push({ start, end, text: text.slice(start, end) });
      start = end;
    }
  } finally {
    probe.remove();
  }
  return made.length ? made : [{ start: 0, end: 0, text: "这本书暂时没有可显示的内容。" }];
}

function activeChapter() {
  return chapters[currentChapterIndex] || { index: 0, title: "正文", start: 0, end: currentBook?.content.length || 1 };
}

function percentForPage() {
  if (!pages.length || !currentBook) return 0;
  const chapter = activeChapter();
  const end = chapter.start + pages[currentPage].end;
  return Math.min(100, Math.max(0, Math.round((end / Math.max(currentBook.content.length, 1)) * 100)));
}

function applySettings() {
  readerView.classList.remove("theme-paper", "theme-sepia", "theme-night");
  readerView.classList.add(`theme-${state.settings.theme}`);
  applyAppChrome(state.settings.theme);
  pageText.style.fontSize = `${state.settings.fontSize}px`;
  pageText.style.lineHeight = state.settings.lineHeight;
  pageText.style.fontWeight = state.settings.fontWeight;
  fontSizeLabel.textContent = state.settings.fontSize;
  document.querySelectorAll("[data-weight]").forEach((button) => button.classList.toggle("selected", Number(button.dataset.weight) === Number(state.settings.fontWeight)));
  document.querySelectorAll("[data-line]").forEach((button) => button.classList.toggle("selected", Number(button.dataset.line) === Number(state.settings.lineHeight)));
  document.querySelectorAll("[data-theme]").forEach((button) => button.classList.toggle("selected", button.dataset.theme === state.settings.theme));
}

function updateReader(save = true, pageTurn = null) {
  if (!currentBook || !pages.length) return;
  currentPage = Math.min(Math.max(currentPage, 0), pages.length - 1);
  const chapter = activeChapter();
  const offset = chapter.start + pages[currentPage].start;
  const percent = percentForPage();
  pageText.textContent = pages[currentPage].text;
  readerBookTitle.textContent = currentBook.title;
  readerChapterTitle.textContent = chapter.title;
  readerMinimalChapter.textContent = chapter.title;
  progressBar.style.width = `${percent}%`;
  progressText.textContent = `本章 ${currentPage + 1} / ${pages.length} 页 · 全书 ${percent}%`;
  readerPageStatus.textContent = `本章 ${currentPage + 1} / ${pages.length} 页`;
  updateReaderClock();
  if (pageTurn) {
    pageText.classList.remove("page-turn-next", "page-turn-previous");
    void pageText.offsetWidth;
    pageText.classList.add(`page-turn-${pageTurn}`);
  }
  if (save) {
    state.progress[currentBook.id] = { offset, chapter: currentChapterIndex, page: currentPage, percent, updatedAt: new Date().toISOString() };
    saveState().catch(() => {});
  }
}

function renderToc() {
  tocList.innerHTML = chapters.map((chapter) => `<button class="toc-item" data-chapter-index="${chapter.index}">${escapeHtml(chapter.title)}</button>`).join("");
}

function chapterIndexForOffset(offset) {
  const index = chapters.findIndex((chapter) => chapter.end > offset);
  return index >= 0 ? index : Math.max(0, chapters.length - 1);
}

function loadChapter(index, targetOffset = null, save = false, pageTurn = null) {
  const chapter = chapters[index];
  if (!chapter || !currentBook) return;
  currentChapterIndex = index;
  pages = createPages(currentBook.content.slice(chapter.start, chapter.end));
  const localOffset = Number.isInteger(targetOffset) ? Math.max(0, targetOffset - chapter.start) : 0;
  const pageIndex = pages.findIndex((page) => page.end > localOffset);
  currentPage = pageIndex >= 0 ? pageIndex : Math.max(0, pages.length - 1);
  updateReader(save, pageTurn);
}

async function openBook(id) {
  shelfView.classList.add("hidden");
  readerView.classList.remove("hidden");
  readerView.classList.remove("controls-visible");
  document.body.classList.add("reading-mode");
  pageText.textContent = "正在从本机打开…";
  progressText.textContent = "本机书籍";
  await frame();
  currentBook = await readStore("books", id);
  if (!currentBook) throw new Error("找不到这本本机书籍。");
  let bookChanged = false;
  let stateChanged = false;
  if (currentBook.textNormalizationVersion !== TEXT_NORMALIZATION_VERSION) {
    const sourceContent = currentBook.content || "";
    const normalizedContent = normalizeReadingText(sourceContent);
    if (normalizedContent !== sourceContent) {
      const progress = state.progress[id];
      if (progress) {
        progress.offset = normalizedOffset(sourceContent, progress.offset);
        stateChanged = true;
      }
    }
    currentBook.content = normalizedContent;
    currentBook.chapters = makeChapters(normalizedContent);
    currentBook.chapterParserVersion = CHAPTER_PARSER_VERSION;
    currentBook.textNormalizationVersion = TEXT_NORMALIZATION_VERSION;
    bookChanged = true;
  }
  const shouldRefreshChapters = !currentBook.chapters?.length || currentBook.chapterParserVersion !== CHAPTER_PARSER_VERSION;
  chapters = shouldRefreshChapters ? makeChapters(currentBook.content) : currentBook.chapters;
  if (shouldRefreshChapters) {
    currentBook.chapters = chapters;
    currentBook.chapterParserVersion = CHAPTER_PARSER_VERSION;
    bookChanged = true;
  }
  if (bookChanged) await writeStore("books", currentBook);
  if (stateChanged) await saveState();
  applySettings();
  const offset = state.progress[id]?.offset || 0;
  loadChapter(chapterIndexForOffset(offset), offset, false);
  readingPage.focus();
}

function closeBook() {
  tocPanel.classList.add("hidden");
  settingsPanel.classList.add("hidden");
  readerView.classList.remove("controls-visible");
  readerView.classList.add("hidden");
  shelfView.classList.remove("hidden");
  document.body.classList.remove("reading-mode");
  applyAppChrome("paper");
  refreshBooks().catch(() => {});
}

function goNextPage() {
  if (currentPage < pages.length - 1) {
    currentPage += 1;
    updateReader(true, "next");
  } else if (currentChapterIndex < chapters.length - 1) {
    loadChapter(currentChapterIndex + 1, chapters[currentChapterIndex + 1].start, true, "next");
  }
}

function goPreviousPage() {
  if (currentPage > 0) {
    currentPage -= 1;
    updateReader(true, "previous");
  } else if (currentChapterIndex > 0) {
    loadChapter(currentChapterIndex - 1, chapters[currentChapterIndex - 1].end - 1, true, "previous");
  }
}

function repaginateCurrentChapter() {
  if (!currentBook || !pages.length) return;
  const offset = activeChapter().start + pages[currentPage].start;
  loadChapter(currentChapterIndex, offset, false);
}

function showReaderControls() {
  readerView.classList.add("controls-visible");
}

function hideReaderControls() {
  readerView.classList.remove("controls-visible");
  tocPanel.classList.add("hidden");
  settingsPanel.classList.add("hidden");
}

function isSettingsOpen() {
  return !settingsPanel.classList.contains("hidden");
}

bookList.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  const openId = button?.dataset.openBook;
  const deleteId = button?.dataset.deleteBook;
  if (openId) {
    try { await openBook(openId); }
    catch (error) {
      pageText.textContent = `打开失败：${error.message}`;
      readerBookTitle.textContent = "暂时无法打开";
    }
  }
  if (deleteId && confirm("确定从这台设备删除这本书吗？")) {
    await removeStore("books", deleteId);
    delete state.progress[deleteId];
    await saveState();
    await refreshBooks();
  }
});

importInput.addEventListener("change", async () => {
  const [file] = importInput.files;
  if (!file) return;
  importMessage.textContent = "正在保存到这台设备…";
  try {
    await frame();
    const content = normalizeReadingText(await file.text());
    const metadata = bookMetadata(file, content);
    const book = {
      id: newId(), filename: file.name, ...metadata, size: file.size, type: "TXT",
      updatedAt: new Date().toISOString(), content, chapters: makeChapters(content),
      chapterParserVersion: CHAPTER_PARSER_VERSION, textNormalizationVersion: TEXT_NORMALIZATION_VERSION
    };
    await writeStore("books", book);
    importMessage.textContent = "已保存到本机，可离线阅读。";
    await refreshBooks();
  } catch (error) { importMessage.textContent = error.message || "导入没有完成。"; }
  importInput.value = "";
});

document.querySelector("#back-to-shelf").addEventListener("click", closeBook);
document.querySelector("#previous-page").addEventListener("click", () => { goPreviousPage(); hideReaderControls(); });
document.querySelector("#next-page").addEventListener("click", () => { goNextPage(); hideReaderControls(); });
document.querySelector("#toc-button").addEventListener("click", () => { renderToc(); tocPanel.classList.toggle("hidden"); });
document.querySelector("#close-toc").addEventListener("click", () => tocPanel.classList.add("hidden"));
document.querySelector("#settings-button").addEventListener("click", () => settingsPanel.classList.toggle("hidden"));
document.querySelector("#close-settings").addEventListener("click", () => settingsPanel.classList.add("hidden"));

["click", "pointerdown", "pointerup"].forEach((eventName) => {
  settingsPanel.addEventListener(eventName, (event) => event.stopPropagation());
});

tocPanel.addEventListener("click", (event) => {
  const chapterButton = event.target.closest("[data-chapter-index]");
  if (chapterButton) {
    tocPanel.classList.add("hidden");
    loadChapter(Number(chapterButton.dataset.chapterIndex), null, true);
    hideReaderControls();
  }
});

function updateSetting(change) {
  change();
  applySettings();
  repaginateCurrentChapter();
  saveState().catch(() => {});
}

document.querySelectorAll("[data-weight]").forEach((button) => button.addEventListener("click", () => updateSetting(() => { state.settings.fontWeight = Number(button.dataset.weight); })));
document.querySelectorAll("[data-line]").forEach((button) => button.addEventListener("click", () => updateSetting(() => { state.settings.lineHeight = Number(button.dataset.line); })));
document.querySelectorAll("[data-theme]").forEach((button) => button.addEventListener("click", () => updateSetting(() => { state.settings.theme = button.dataset.theme; })));
document.querySelector("#decrease-font").addEventListener("click", () => updateSetting(() => { state.settings.fontSize = Math.max(15, state.settings.fontSize - 1); }));
document.querySelector("#increase-font").addEventListener("click", () => updateSetting(() => { state.settings.fontSize = Math.min(32, state.settings.fontSize + 1); }));

readingPage.addEventListener("click", (event) => {
  if (isSettingsOpen()) return;
  if (suppressPageClick) { suppressPageClick = false; return; }
  if (event.target.closest("button")) return;
  if (readerView.classList.contains("controls-visible")) {
    hideReaderControls();
    return;
  }
  const rect = readingPage.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const isMenuZone = x > rect.width * 0.24 && x < rect.width * 0.76 && y > rect.height * 0.31 && y < rect.height * 0.69;
  if (isMenuZone) {
    showReaderControls();
  } else {
    goNextPage();
  }
});
readingPage.addEventListener("pointerdown", (event) => {
  if (isSettingsOpen()) { pointerStart = null; return; }
  pointerStart = event.clientX;
});
readingPage.addEventListener("pointerup", (event) => {
  if (isSettingsOpen()) { pointerStart = null; return; }
  if (pointerStart === null) return;
  const delta = event.clientX - pointerStart;
  pointerStart = null;
  if (delta < -55) { suppressPageClick = true; hideReaderControls(); goNextPage(); }
  else if (delta > 55) { suppressPageClick = true; hideReaderControls(); goPreviousPage(); }
});
readingPage.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
readingPage.addEventListener("keydown", (event) => {
  if (isSettingsOpen()) return;
  if (event.key === "ArrowLeft") { event.preventDefault(); hideReaderControls(); goPreviousPage(); }
  if (event.key === "ArrowRight" || event.key === " ") { event.preventDefault(); hideReaderControls(); goNextPage(); }
});
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(repaginateCurrentChapter, 120);
});

async function boot() {
  try {
    await loadState();
    await refreshBooks();
    updateReaderClock();
    window.setInterval(updateReaderClock, 30_000);
  } catch {
    bookList.innerHTML = '<p class="empty-note">本机书房暂时无法打开，请检查浏览器是否允许网站数据存储。</p>';
  }
}

boot();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js?v=5").catch(() => {});
}
