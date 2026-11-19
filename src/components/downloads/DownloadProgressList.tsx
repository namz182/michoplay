import type { ReactNode, ComponentProps } from "react";
import { groupDownloads } from "../../lib/downloads";
import { PlaylistDownloadProgress } from "./PlaylistDownloadProgress";

type Props = ComponentProps<typeof PlaylistDownloadProgress> & {
  renderSong: (item: Props["downloads"][number]) => ReactNode;
};

export function DownloadProgressList({ downloads, renderSong, ...actions }: Props) {
  return groupDownloads(downloads).map((entry) => entry.playlist
    ? <PlaylistDownloadProgress key={entry.key} downloads={entry.items} {...actions} />
    : <div key={entry.key}>{renderSong(entry.items[0])}</div>);
}
