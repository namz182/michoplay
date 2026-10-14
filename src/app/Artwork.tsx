import { useEffect, useRef, useState } from "react";
import { Disc3 } from "lucide-react";
import { api } from "../lib/api";

const requests = new Map<string, Promise<string | null>>();
export function useArtwork(key: string | null | undefined, enabled = true) {
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!key || !enabled) return;
    let active = true;
    let request = requests.get(key);
    if (!request) {
      request = api.artwork(key).catch(() => null);
      requests.set(key, request);
    }
    void request.then((url) => {
      if (!url) requests.delete(key);
      if (active && url) setImage({ key, url });
    });
    return () => { active = false; };
  }, [key, enabled]);
  return image && image.key === key ? image.url : null;
}
function Image({ artworkKey, enabled }: { artworkKey: string; enabled: boolean }) {
  const url = useArtwork(artworkKey, enabled);
  return url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <span className="cover-missing"><Disc3 size={20} /></span>;
}
export function Cover({ keys, className = "", icon }: { keys: (string | null | undefined)[]; className?: string; icon?: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const unique = [...new Set(keys.filter((key): key is string => Boolean(key)))].slice(0, 4);
  const chosen = unique.length === 4 ? unique : unique.slice(0, 1);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return <span ref={ref} className={`cover ${chosen.length === 4 ? "cover-mosaic" : ""} ${className}`}>
    {chosen.length ? chosen.map((key) => <Image key={key} artworkKey={key} enabled={visible} />) : <span className="cover-missing">{icon ?? <Disc3 size={25} />}</span>}
  </span>;
}
