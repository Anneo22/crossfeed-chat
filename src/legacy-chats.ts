import {check, object} from './security.ts';

// Match the raw string, not a URL-normalized variant (ports, escapes, queries and whitespace are forbidden).
export const legacyChatURL = (value: unknown): value is string => typeof value === 'string' && /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]{1,128}$/.test(value);
export function parseLegacyChats(value: unknown) {
  check(object(value) && (value.chats !== undefined || value._archive_pending !== undefined), 'Invalid legacy chat state');
  check(value.chats === undefined || object(value.chats), 'Invalid legacy chats');
  check(value._archive_pending === undefined || Array.isArray(value._archive_pending), 'Invalid legacy pending chats');
  const urls: string[] = []; let invalid = 0;
  for (const chat of Object.values(value.chats ?? {})) {
    if (object(chat) && legacyChatURL(chat.url)) urls.push(chat.url); else invalid++;
  }
  for (const id of value._archive_pending ?? []) {
    if (typeof id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(id)) urls.push('https://chatgpt.com/c/'+id); else invalid++;
  }
  check(urls.length + invalid <= 8192, 'Too many legacy chats');
  return {urls, invalid};
}
