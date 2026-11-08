import type { RefObject } from "react";
import { Download, Home, Library, Search, Youtube } from "lucide-react";
import type { Section } from "../types";

type Props = {
  mobileTab: "home" | "search" | "library" | "youtube" | "downloads";
  section: Section;
  downloadCount: number;
  downloadNavRef: RefObject<HTMLButtonElement | null>;
  onHome: () => void;
  onLibrary: () => void;
  onYoutube: () => void;
  onDownloads: () => void;
  onSearch: () => void;
};

export function MobileNav({ mobileTab, section, downloadCount, downloadNavRef, onHome, onLibrary, onYoutube, onDownloads, onSearch }: Props) {
  return <>
    <nav className={`mobile-bottom-nav ${section === "Settings" ? "settings-open" : ""}`} aria-label="Main navigation">
      <button className={mobileTab === "home" && section !== "Settings" ? "active" : ""} onClick={onHome}><Home size={22}/><span>Home</span></button>
      <button className={mobileTab === "library" ? "active" : ""} onClick={onLibrary}><Library size={22}/><span>Library</span></button>
      <button className={mobileTab === "youtube" ? "active" : ""} onClick={onYoutube}><Youtube size={22}/><span>YouTube</span></button>
      <button ref={downloadNavRef} className={`mobile-downloads-nav ${mobileTab === "downloads" ? "active" : ""}`} aria-label={downloadCount ? `Downloads, ${downloadCount} active or new` : "Downloads"} onClick={onDownloads}>
        <Download size={22}/>
        {downloadCount > 0 && <span className="mobile-download-badge" aria-hidden="true">{downloadCount > 99 ? "99+" : downloadCount}</span>}
        <span>Downloads</span>
      </button>
    </nav>
    <button className={`mobile-nav-search ${mobileTab === "search" ? "active" : ""} ${section === "Settings" ? "settings-open" : ""}`} aria-label="Search" aria-pressed={mobileTab === "search"} onClick={onSearch}><Search size={24}/></button>
  </>;
}
