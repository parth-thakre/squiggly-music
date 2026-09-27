import { useState } from 'react';
import { configApi, openConfigFolder } from '../config';
import { current, usePlayer } from '../player';
import { usePalette } from '../ui';
import type { Palette } from '../palette';
import { selectTheme, themePalette, useThemes, type Theme } from './index';
import { fontStack } from './tokens';

// Settings › Theme. Picking one applies it at once, so the page itself is the preview.
export function ThemeSettings() {
  const { themes, chosen, active, problems, notes } = useThemes();
  const cover = usePalette(usePlayer(s => current(s)?.coverArt ?? null));
  const [opened, setOpened] = useState<string | null>(null);
  const origin = (theme: Theme) => theme.source === 'user' ? `From themes/${theme.id.slice('user:'.length)}.json.` : theme.source === 'extension' ? `From ${theme.owner}.` : '';
  return <>
    <h2 id="theme">Theme</h2>
    <div role="radiogroup" aria-label="Theme" className="themes">
      {themes.map(theme => <label key={theme.id} className="setting theme-choice">
        <input type="radio" name="theme" value={theme.id} checked={active.id === theme.id} onChange={() => selectTheme(theme.id)} />
        <span><strong>{theme.name}</strong><span>{[theme.description, origin(theme)].filter(Boolean).join(' ')}</span></span>
        <Sample theme={theme} cover={cover} />
      </label>)}
    </div>
    {chosen !== active.id && <p className="note">The theme you picked isn't loaded right now, so Cover is showing. It returns when its file or extension does.</p>}
    {problems.length > 0 && <div className="problems" role="alert">
      <p className="problems-head">{problems.length === 1 ? 'One theme problem' : `${problems.length} theme problems`}</p>
      <ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>
    </div>}
    {notes.length > 0 && <div className="problems"><p className="problems-head">Colours adjusted to stay readable</p><ul className="quiet">{notes.map(note => <li key={note}>{note}</li>)}</ul></div>}
    {configApi ? <>
      <p className="note">Add your own by saving a .json file in the themes folder, inside the config folder. Changes apply when you save.</p>
      <div className="actions settings-actions"><button type="button" className="text-button" onClick={async () => setOpened(await openConfigFolder())}>Open the config folder</button></div>
      {opened && <p className="note" role="alert">{opened}</p>}
    </> : <p className="note hint">Themes from files load in the desktop app, from the themes folder in its config folder.</p>}
  </>;
}

// A small sleeve in the theme's colours and display type.
function Sample({ theme, cover }: { theme: Theme; cover: Palette }) {
  const palette = themePalette(theme) ?? cover;
  return <span className="theme-sample" aria-hidden="true" style={{ background: palette.ground, color: palette.ink, fontFamily: fontStack(theme.tokens.type.display, 'display'), borderRadius: Math.min(theme.tokens.radius, 6) }}>
    <span>Aa</span>
    <svg viewBox="0 0 30 8"><path d="M1 4 Q 4.5 0 8 4 T 15 4 T 22 4 T 29 4" fill="none" stroke={palette.accent} strokeWidth="2" strokeLinecap="round" /></svg>
  </span>;
}
