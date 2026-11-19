import { Disc3, Music2, Youtube } from "lucide-react";
import { Cover } from "../../app/Artwork";

type Section = "Songs";

export function HomeQuickLinks({
  songCount,
  onNavigate,
  onYoutube,
  onSpotify,
}: {
  songCount: number;
  onNavigate: (section: Section) => void;
  onYoutube: () => void;
  onSpotify?: () => void;
}) {
  return (
    <div
      className="home-quick-grid home-library-links"
      aria-label="Library shortcuts"
    >
      <button className="home-quick-card" onClick={() => onNavigate("Songs")}>
        <Cover
          className="home-quick-art"
          keys={[]}
          icon={<Music2 size={21} />}
        />
        <span>
          <strong>All Songs</strong>
          <small>
            {songCount} {songCount === 1 ? "song" : "songs"}
          </small>
        </span>
      </button>
      <button className="home-quick-card home-youtube-link" onClick={onYoutube}>
        <span className="home-quick-art">
          <Youtube size={22} />
        </span>
        <span>
          <strong>YouTube</strong>
          <small>Search and download audio</small>
        </span>
      </button>
      {onSpotify && (
        <button
          className="home-quick-card home-spotify-link"
          onClick={onSpotify}
        >
          <span className="home-quick-art">
            <Disc3 size={22} />
          </span>
          <span>
            <strong>Spotify</strong>
            <small>Find a song, album, or playlist</small>
          </span>
        </button>
      )}
    </div>
  );
}
