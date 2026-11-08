import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";

export function DesktopGlobalSearch({
  value,
  open,
  content,
  onChange,
  onOpenChange,
}: {
  value: string;
  open: boolean;
  content: ReactNode;
  onChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setDraft(value);
  }, [value]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const update = (next: string) => {
    setDraft(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      onChange(next);
    }, 80);
  };
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setDraft("");
    onChange("");
    onOpenChange(true);
  };
  return (
    <div className={`search-box global-search ${open ? "expanded" : ""}`} role="search">
      <Search size={17} />
      <input
        aria-label="Search all music"
        aria-expanded={open}
        aria-controls="global-search-results"
        placeholder="What do you want to play?"
        value={draft}
        onFocus={() => onOpenChange(true)}
        onChange={(event) => { update(event.target.value); onOpenChange(true); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onOpenChange(false);
          else if (event.key === "ArrowDown") {
            event.preventDefault();
            document.querySelector<HTMLButtonElement>(".global-search-result")?.focus();
          } else if (event.key === "Enter") event.preventDefault();
        }}
      />
      {draft && <button className="icon-button" aria-label="Clear search" onClick={clear}><X size={15} /></button>}
      {open && <div className="global-search-popover" id="global-search-results" role="listbox" aria-label="Search results">{content}</div>}
    </div>
  );
}

export function BufferedYoutubeSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setDraft(value);
  }, [value]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const update = (next: string) => {
    setDraft(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      onChange(next);
    }, 100);
  };
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setDraft("");
    onChange("");
  };
  return (
    <label className="search-box youtube-global-search">
      <Search size={17} />
      <input type="text" aria-label="Search YouTube" placeholder="Song, artist, or paste a link" value={draft} onChange={(event) => update(event.target.value)} />
      {draft && <button type="button" aria-label="Clear search" onClick={clear}><X size={15} /></button>}
    </label>
  );
}
