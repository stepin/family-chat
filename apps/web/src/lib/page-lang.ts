// The language of the check pages /device/ and /server/ (M7): the same
// choice as the app (Settings, else the system's languages, else Russian).
// These pages are small and rarely opened, so both languages are in their
// code: Russian is written in the HTML, and every element with `data-en`
// gets its English text when the page speaks English.

import { readLangPref, resolveLang, systemLanguages, type Lang } from './locale.ts';

export let pageLang: Lang = resolveLang(readLangPref(), systemLanguages());

/** For tests: the language of the texts below. */
export function setPageLang(lang: Lang): void {
  pageLang = lang;
}

/** The Russian or the English text, by the page language. */
export function tr(ru: string, en: string): string {
  return pageLang === 'en' ? en : ru;
}

/** Applies the language to the static part of the page: `<html lang>`, `data-en` texts and placeholders, the title. */
export function localizePage(doc: Document = document): void {
  doc.documentElement.lang = pageLang;
  if (pageLang !== 'en') return;
  for (const el of doc.querySelectorAll<HTMLElement>('[data-en]')) el.textContent = el.dataset['en'] ?? el.textContent;
  for (const el of doc.querySelectorAll<HTMLInputElement>('[data-en-placeholder]')) el.placeholder = el.dataset['enPlaceholder'] ?? el.placeholder;
  const title = doc.querySelector<HTMLTitleElement>('title[data-en]');
  if (title) doc.title = title.dataset['en'] ?? doc.title;
}
