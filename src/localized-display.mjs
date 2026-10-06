import { GatewayError } from './audit.mjs';
const check = (value, code) => { if (!value) throw new GatewayError(code); };
export function normalizeLocale(value) {
  check(typeof value === 'string' && value.length <= 32 && /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/.test(value), 'InvalidLocale');
  return value.split('-').map((part, i) => i === 0 ? part.toLowerCase() : part.length === 4 ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part.toUpperCase()).join('-');
}
export function validateDisplayLocalization(value) {
  const trim = text => text.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');
  const map = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  check(map(value), 'InvalidMetadata');
  check(Object.keys(value).every(k => ['defaultLocale', 'translations'].includes(k)), 'UnknownField');
  check(Object.hasOwn(value, 'translations'), 'MissingField');
  check(map(value.translations), 'InvalidMetadata');
  const locales = new Set(); let total = 0, name = false, summary = false;
  for (const [raw, fields] of Object.entries(value.translations)) {
    const locale = normalizeLocale(raw);
    check(!locales.has(locale), 'DuplicateLocale'); locales.add(locale);
    check(locales.size <= 16, 'LocalizationLimit'); check(map(fields), 'InvalidMetadata');
    for (const [key, text] of Object.entries(fields)) {
      check(['name', 'summary', 'changelog'].includes(key), 'UnknownField');
      check(typeof text === 'string', 'InvalidMetadata');
      check(text.length > 0 && text.length <= (key === 'name' ? 160 : key === 'summary' ? 1024 : 8192) && trim(text) === text, 'InvalidLocalizationText');
      check(!(key === 'name' ? /[\u0000-\u001f\u007f-\u009f]/ : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/).test(text), 'InvalidLocalizationText');
      check(!/<\/?[A-Za-z][^>]*>/.test(text), 'InvalidLocalizationMarkup');
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdfff) { check(c <= 0xdbff && i + 1 < text.length && text.charCodeAt(++i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff, 'InvalidLocalizationText'); }
      }
      total += text.length; check(total <= 32768, 'LocalizationLimit');
      name ||= key === 'name'; summary ||= key === 'summary';
    }
  }
  if (Object.hasOwn(value, 'defaultLocale')) check(locales.has(normalizeLocale(value.defaultLocale)), 'InvalidDefaultLocale');
  check(name && summary, 'MissingDisplayText');
  return value;
}
