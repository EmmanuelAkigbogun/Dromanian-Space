import { useState, useMemo, useRef, useEffect, memo, useCallback } from 'react';
import { Portal } from '@/lib/overlay/Portal';
import styles from './EmojiPicker.module.css';

// ---------------------------------------------------------------------------
// "Emojis" categories — your original emoji-style sets (unchanged content)
// ---------------------------------------------------------------------------
const OTHER_CATEGORIES = [
  {
    name: 'Smileys',
    emojis: ['😀', '😂', '😍', '🤩', '😎', '🤔', '😅', '🥳', '😴', '🤯', '😱', '🤗', '😇', '🙄', '😬'],
  },
  {
    name: 'Gestures',
    emojis: ['👍', '👎', '👋', '✌️', '🤝', '🙏', '💪', '🫶', '👏', '🙌', '🤙', '👆', '👇', '✋'],
  },
  {
    name: 'Hearts',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💕', '💞', '💓', '💗', '💖', '💝', '❤️‍🔥', '💔'],
  },
  {
    name: 'Objects',
    emojis: ['🔥', '⭐', '🌟', '💡', '🎉', '🎊', '🏆', '🎯', '💎', '🚀', '📌', '📎', '✅', '❌', '⚡︎', '💫'],
  },
  {
    name: 'Nature',
    emojis: ['🌈', '☀️', '🌙', '⛅', '🌊', '🌸', '🌺', '🍀', '🌿', '🦋', '🐝', '🦊', '🐱', '🐶', '🐻', '🐼'],
  },
];

// ---------------------------------------------------------------------------
// "Symbols" categories — sanitized vector symbols, split into real sub-groups
// (raw key -> friendly display name)
// ---------------------------------------------------------------------------
const SYMBOL_LABELS: Record<string, string> = {
  heartsAndStars: 'Hearts & Stars',
  facesAndExpressions: 'Faces',
  flowersAndNature: 'Flowers & Nature',
  spaceAndWeather: 'Space & Weather',
  arrowsAndPointers: 'Arrows',
  geometricShapes: 'Shapes',
  musicAndArt: 'Music & Art',
  badgesAndRoyal: 'Badges & Royal',
  officeAndTools: 'Office & Tools',
  spiritualAndCultural: 'Spiritual & Cultural',
  mathAndCurrency: 'Math & Currency',
};

const SYMBOL_CATEGORIES_RAW: Record<string, string[]> = {
  heartsAndStars: ['♥', '♡', '❤', '❥', '❦', '❧', '★', '☆', '✦', '✧', '✩', '✪', '✫', '✬', '✭', '✮', '✯', '✰', '✨︎', '🌟︎'],
  flowersAndNature: ['✿', '❀', '❁', '✾', '❃', '⚘', '☘︎', '💮︎', '🌸︎', '🌹︎', '🌺︎', '🌻︎', '🌼︎', '🌷︎', '🍀︎', '💐︎', '🌾︎', '🌱︎', '🌿︎', '🍃︎', '🍁︎', '🌵︎', '🌴︎', '🌲︎', '🌳︎', '🍂︎', '🍄︎', '🐚︎'],
  spaceAndWeather: ['☾', '☽', '☉', '☼', '⚡︎', '☄︎', '❄︎', '☃︎', '❆', '❅', '❉', '❊', '❋', '🌌︎', '🔭︎', '🛰︎', '📡︎', '🌑︎', '🌒︎', '🌓︎', '🌔︎', '🌕︎', '🌖︎', '🌗︎', '🌘︎', '🌙︎', '🌚︎', '🌛︎', '🌜︎', '🌍︎', '🌎︎', '🌏︎', '🌐︎', '🗺︎', '🏔︎', '⛰︎', '🌋︎', '🗻︎', '⛺︎', '🌊︎', '💧︎', '🌬︎', '🌪︎', '🌫︎', '⛅︎', '⛈︎', '🌤︎', '🌥︎', '🌦︎', '🌧︎', '🌨︎', '🌩︎', '🔥︎', '💥︎', '✨︎', '🌠︎', '🌈︎', '☔︎'],
  facesAndExpressions: ['☺︎', '☻︎', '☹︎', '☠︎', '👿︎', '💀︎', '💩︎', '🥷︎', '👹︎', '👺︎', '🕶︎', '🥸︎', '🤖︎', '🤡︎', '👻︎', '👽︎', '👁︎', '🗣︎', '👤︎', '👥︎', '〠', '⚇', '⚉', '😎︎', '🤓︎'],
  arrowsAndPointers: ['➤', '➜', '➢', '→', '←', '↑', '↓', '↔', '↕', '↗', '↘', '↙', '↖', '↦', '↩', '↪', '↺', '↻', '⇄', '⇅', '⇆', '⇇', '⇈', '⇉', '⇊', '⇐', '⇒', '⇔', '⇑', '⇓', '⇕', '⤴', '⤵', '➔', '➘', '➙', '➚', '➛', '➝', '➞', '➟', '➠', '➡', '➥', '➦', '➧', '➨', '➩', '➪', '➫', '➬', '➭', '➮', '➯', '➱', '➲', '➳', '➴', '➵', '➶', '➷', '➸', '➹', '➺', '➻', '➼', '➽', '➾', '☜', '☝︎', '☞', '☟', '☚', '☛'],
  geometricShapes: ['◆', '◇', '❖', '⬤', '◉', '◐', '◑', '▸', '◂', '▴', '▾', '▦', '▩', '■', '□', '▢', '▣', '▤', '▥', '▧', '▨', '▪', '▫', '▬', '▭', '▮', '▲', '△', '▶', '▷', '▼', '▽', '◀', '◁', '◊', '○', '●', '◎', '◔', '◕', '◖', '◗', '◘', '◙', '◚', '◛', '◜', '◝', '◞', '◟', '◠', '◡', '◢', '◣', '◤', '◥', '◧', '◨', '◩', '◪', '◫', '◬', '◭', '◮', '◯', '⬥', '⬦', '⬧', '⬬', '⬭', '⬮', '⬯', '⬳', '⬴', '⬵', '⬶', '⬷', '⬸', '⬹', '⬺', '⬻', '⬼', '⬽', '⬾', '⬿', '⬢', '🌀︎', '⛶', '⚬'],
  musicAndArt: ['♪', '♫', '♬', '♩', '♭', '♮', '♯', '🎭︎', '🎨︎', '🎻︎', '🎼︎', '🎹︎', '🎷︎', '🎺︎', '🎸︎', '🥁︎', '🎬︎', '🎤︎', '🎧︎', '📻︎', '📺︎', '📼︎', '🎟︎', '🎫︎'],
  badgesAndRoyal: ['♔', '♕', '♖', '♗', '♘', '♙', '♚', '♛', '♜', '♝', '♞', '♟', '🏅︎', '🎖︎', '🏆︎', '🏵︎', '🎗︎', '👑︎', '💍︎', '💎︎'],
  officeAndTools: ['✁', '✂', '🪡︎', '🪮︎', '🪞︎', '🪟︎', '🚪︎', '🔑︎', '🗝︎', '🔨︎', '⛏︎', '⚒︎', '🛠︎', '🗡︎', '🔧︎', '🪛︎', '🔩︎', '⚙︎', '🗜︎', '⚖︎', '🔗︎', '🪝︎', '🪜︎', '🔬︎', '📄︎', '📁︎', '📂︎', '📅︎', '📆︎', '🗒︎', '🗓︎', '📇︎', '📋︎', '📌︎', '📍︎', '📎︎', '🖇︎', '📐︎', '📏︎', '✉︎'],
  spiritualAndCultural: ['☮', '☯', '✜', '✞', '✝', '☦︎', '🛐︎', '🕎︎', '⚛︎', '⚕︎', '♰', '♱', '♠', '♢', '♣', '♤', '♦', '♧', '♨', '☿', '♀', '♂', '♃', '♄', '♅', '♆', '♇', '❂', '⚜', '⚚', '☤', '☥', '⛤', '⛥', '⛦', '⛯', '⚓︎', '⚙', '⚿', '⛻', '⛼', '⛾', '⚵', '⚶', '⚷', '🕯︎', '💡︎', '🏮︎', '🔱︎', '🕉︎', '☸︎', '⛓︎', '⚔︎', '🛡︎', '🏹︎', '🏺︎', '🔮︎', '📿︎', '💈︎', '🛎︎', '✉', '✎', '✏', '✐', '✑', '✒', '✙', '✚', '✛', '✱', '✲', '✻', '✼', '❍', '❏', '❐', '❑', '❒', '❘', '❙', '❚', '❛', '❜', '❝', '❞', '☐', '☑︎', '☒', '☓', '✍︎', '✌︎', '☰', '☱', '☲', '☳', '☴', '☵', '☶', '☷', '⚭', '⚮', '⚯', '⚲', '⚳', '⚴', '⛀', '⛁', '⛂', '⛃', '⌘', '⌂', '⌈', '⌉', '⌊', '⌋', '⌒', '✔', '✘', '✓', '✗', '•', '·', '※', '§', '¶', '†', '‡', '¤', '°', '◦', '©', '®', '™', '✈︎', '💼︎'],
  mathAndCurrency: ['≈', '≡', '≠', '≤', '≥', '⊂', '⊃', '⊆', '⊇', '∪', '∩', '∧', '∨', '¬', '√', '∛', '∜', '∑', '∏', '∞', '∫', '∮', '∥', '⊥', '∠', '∡', '⊕', '⊗', '⊙', '⊿', '∆', '∇', '∂', '∝', '≀', '≍', '€', '£', '¥', '¢', '₩', '₨', '₪', '₱', '₽', '$', '℘', '℗', '℠'],
};

// Order + friendly names, built once
const SYMBOL_CATEGORIES = Object.keys(SYMBOL_CATEGORIES_RAW).map((key) => ({
  name: SYMBOL_LABELS[key] ?? key,
  emojis: SYMBOL_CATEGORIES_RAW[key],
}));

const QUICK_REACTIONS = ['❤', '✨︎', '🌟︎', '🌸︎', '👽︎', '🌿︎', '😎︎', '🍁︎'];

// The two top-level groups
const TOP_TABS = [
  { key: 'symbols' as const, label: 'Symbols', categories: SYMBOL_CATEGORIES },
  { key: 'emojis' as const, label: 'Emojis', categories: OTHER_CATEGORIES },
];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  position?: { x: number; y: number };
  showCloseButton?: boolean;
}

export const EmojiPicker = memo(function EmojiPicker({ onSelect, onClose, anchorRef, position, showCloseButton }: EmojiPickerProps) {
  const [search, setSearch] = useState('');
  const [topTabIndex, setTopTabIndex] = useState(0);
  const [activeCategory, setActiveCategory] = useState(0);
  const pickerRef = useRef<HTMLDivElement>(null);

  const currentTab = TOP_TABS[topTabIndex];

  // reset the sub-category whenever the top-level tab changes
  const handleTopTabChange = useCallback((index: number) => {
    setTopTabIndex(index);
    setActiveCategory(0);
    setSearch('');
  }, []);

  const filteredCategories = useMemo(() => {
    if (!search) return currentTab.categories;
    const query = search.toLowerCase();
    return currentTab.categories
      .map((cat) => ({
        ...cat,
        emojis: cat.name.toLowerCase().includes(query) ? cat.emojis : [],
      }))
      .filter((cat) => cat.emojis.length > 0);
  }, [search, currentTab]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, anchorRef]);

  const pickerStyle = useMemo(() => {
    if (!position) return undefined;
    const pickerWidth = 320;
    const pickerHeight = 440;
    const margin = 8;
    let x = position.x;
    let y = position.y;
    if (x + pickerWidth + margin > window.innerWidth) {
      x = window.innerWidth - pickerWidth - margin;
    }
    if (y + pickerHeight + margin > window.innerHeight) {
      y = position.y - pickerHeight - margin;
    }
    if (x < margin) x = margin;
    if (y < margin) y = margin;
    return { left: x, top: y };
  }, [position]);

  const handleSelect = useCallback(
    (emoji: string) => {
      onSelect(emoji);
      onClose();
    },
    [onSelect, onClose]
  );

  return (
    <Portal>
      <div ref={pickerRef} className={styles.picker} style={pickerStyle}>
        <div className={`${styles.searchWrapper} ${showCloseButton ? styles.searchWrapperWithClose : ''}`}>
          <input
            type="text"
            className={styles.search}
            placeholder="Search emoji..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {showCloseButton && (
            <button
              type="button"
              className={styles.closeButton}
              onClick={onClose}
              aria-label="Close emoji picker"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        <div className={styles.quickReactions}>
          {QUICK_REACTIONS.map((emoji, i) => (
            <button
              key={`${emoji}-${i}`}
              type="button"
              className={styles.quickButton}
              onClick={() => handleSelect(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>

        {/* Top-level tabs: Symbols / Emojis */}
        <div className={styles.topTabs}>
          {TOP_TABS.map((tab, i) => (
            <button
              key={tab.key}
              type="button"
              className={`${styles.topTab} ${i === topTabIndex ? styles.topTabActive : ''}`}
              onClick={() => handleTopTabChange(i)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Sub-category tabs for the active top-level group */}
        <div className={styles.categoriesRow}>
          <div className={styles.categories}>
            {currentTab.categories.map((cat, i) => (
              <button
                key={cat.name}
                type="button"
                className={`${styles.categoryTab} ${i === activeCategory ? styles.categoryActive : ''}`}
                onClick={() => setActiveCategory(i)}
                title={cat.name}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.grid}>
          {(search ? filteredCategories : [currentTab.categories[activeCategory]]).map((cat) => (
            <div key={cat.name}>
              <div className={styles.categoryLabel}>{cat.name}</div>
              <div className={styles.emojiGrid}>
                {cat.emojis.map((emoji, i) => (
                  <button
                    key={`${emoji}-${i}`}
                    type="button"
                    className={styles.emojiButton}
                    onClick={() => handleSelect(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Portal>
  );
});

export { QUICK_REACTIONS };