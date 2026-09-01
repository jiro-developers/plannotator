import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * GitHub/Slack-style emoji autocomplete for the curated review set.
 *
 * Mounted once in RoomApp; works on every comment/reply input in the page via
 * document-level event delegation, including inputs rendered by
 * @plannotator/ui components we don't own (comment popover, edit box).
 *
 * - `:spe` … → dropdown with matches, ↑↓ + Enter/Tab select, Esc dismiss
 * - a fully typed `:check:` still converts in place without the dropdown
 */

interface EmojiEntry {
  emoji: string;
  name: string;
  aliases: string[];
}

const EMOJI_CATALOG: EmojiEntry[] = [
  { emoji: '✅', name: 'check', aliases: ['white_check_mark', 'done', 'ok'] },
  { emoji: '💬', name: 'speech_balloon', aliases: ['comment', 'speech'] },
  { emoji: '❗', name: 'exclamation', aliases: ['!', 'warn', 'important'] },
  { emoji: '❓', name: 'question', aliases: ['?', 'q'] },
  { emoji: '👍', name: 'thumbsup', aliases: ['+1', 'up', 'good'] },
];

const NAME_BY_ALIAS = new Map<string, EmojiEntry>();
for (const entry of EMOJI_CATALOG) {
  NAME_BY_ALIAS.set(entry.name, entry);
  for (const alias of entry.aliases) NAME_BY_ALIAS.set(alias, entry);
}

type EditableField = HTMLTextAreaElement | HTMLInputElement;

function isEditableField(target: unknown): target is EditableField {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.type === 'text')
  );
}

/**
 * The `:query` fragment immediately before the caret, or null.
 * The colon must sit at line start or after whitespace/bracket so colons in
 * ordinary prose ("예: 내용") or URLs don't open the dropdown.
 */
function readQuery(el: EditableField): { start: number; query: string } | null {
  const caret = el.selectionStart;
  if (caret == null || el.selectionEnd !== caret) return null;
  const before = el.value.slice(0, caret);
  const match = /(?:^|[\s([{>])(:([a-z0-9_+!?]*))$/i.exec(before);
  if (!match) return null;
  return { start: caret - match[1].length, query: match[2].toLowerCase() };
}

/** Write a new value into a React-controlled input and keep React in sync. */
function setFieldValue(el: EditableField, nextValue: string, caret: number): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) return;
  setter.call(el, nextValue);
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

interface DropdownState {
  field: EditableField;
  start: number;
  query: string;
  matches: EmojiEntry[];
  left: number;
  top: number;
}

export function EmojiAutocomplete() {
  const [dropdown, setDropdown] = useState<DropdownState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dropdownRef = useRef<DropdownState | null>(null);
  const selectedIndexRef = useRef(0);
  dropdownRef.current = dropdown;
  selectedIndexRef.current = selectedIndex;

  const close = useCallback(() => {
    setDropdown(null);
    setSelectedIndex(0);
  }, []);

  const insert = useCallback(
    (entry: EmojiEntry) => {
      const current = dropdownRef.current;
      if (!current) return;
      const { field, start } = current;
      const caret = field.selectionStart ?? field.value.length;
      const nextValue = field.value.slice(0, start) + entry.emoji + field.value.slice(caret);
      setFieldValue(field, nextValue, start + entry.emoji.length);
      field.focus();
      close();
    },
    [close]
  );

  useEffect(() => {
    const onInput = (e: Event) => {
      if ((e as InputEvent).isComposing) return;
      const target = e.target;
      if (!isEditableField(target)) return;

      // A fully typed `:name:` converts in place, dropdown or not.
      if ((e as InputEvent).data === ':') {
        const caret = target.selectionStart;
        if (caret != null) {
          const before = target.value.slice(0, caret);
          const full = /:([a-z0-9_+!?]{1,24}):$/i.exec(before);
          const entry = full ? NAME_BY_ALIAS.get(full[1].toLowerCase()) : undefined;
          if (full && entry) {
            const start = caret - full[0].length;
            const nextValue = target.value.slice(0, start) + entry.emoji + target.value.slice(caret);
            setFieldValue(target, nextValue, start + entry.emoji.length);
            close();
            return;
          }
        }
      }

      const parsed = readQuery(target);
      if (!parsed || parsed.query.length === 0) {
        close();
        return;
      }
      const matches = EMOJI_CATALOG.filter(
        (entry) =>
          entry.name.startsWith(parsed.query) ||
          entry.aliases.some((alias) => alias.startsWith(parsed.query))
      );
      if (matches.length === 0) {
        close();
        return;
      }
      const rect = target.getBoundingClientRect();
      setDropdown({ field: target, start: parsed.start, query: parsed.query, matches, left: rect.left, top: rect.bottom + 4 });
      setSelectedIndex(0);
    };

    // Capture phase so navigation wins over the field's own Enter/⌘Enter handlers.
    const onKeyDown = (e: KeyboardEvent) => {
      const current = dropdownRef.current;
      if (!current || e.isComposing) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setSelectedIndex((i) => (i + delta + current.matches.length) % current.matches.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        insert(current.matches[selectedIndexRef.current] ?? current.matches[0]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };

    const onDismiss = (e: Event) => {
      const current = dropdownRef.current;
      if (!current) return;
      if (e.type === 'scroll' && e.target instanceof Node && current.field.contains(e.target)) return;
      close();
    };

    document.addEventListener('input', onInput);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onDismiss, true);
    document.addEventListener('focusout', onDismiss);
    return () => {
      document.removeEventListener('input', onInput);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onDismiss, true);
      document.removeEventListener('focusout', onDismiss);
    };
  }, [close, insert]);

  if (!dropdown) return null;

  return (
    <div
      className="fixed z-[10000] min-w-[13rem] overflow-hidden rounded-lg border border-border/60 bg-background shadow-lg"
      style={{ left: dropdown.left, top: dropdown.top }}
      role="listbox"
      aria-label="이모지 자동완성"
    >
      {dropdown.matches.map((entry, index) => (
        <button
          key={entry.name}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          // mousedown so the click wins the race against the input's focusout dismiss
          onMouseDown={(e) => {
            e.preventDefault();
            insert(entry);
          }}
          onMouseEnter={() => setSelectedIndex(index)}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
            index === selectedIndex
              ? 'bg-primary text-primary-foreground'
              : 'text-foreground'
          }`}
        >
          <span aria-hidden>{entry.emoji}</span>
          <span className="font-mono text-xs">{entry.name}</span>
        </button>
      ))}
    </div>
  );
}
