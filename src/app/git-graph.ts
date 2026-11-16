import type { GitCommit } from './git-history.js';

export function commitLanes(items: GitCommit[]) {
  const lanes: (string | undefined)[] = [];
  function reserve(sha: string) {
    const used = lanes.indexOf(sha);
    if (used >= 0) return used;
    const vacant = lanes.indexOf(undefined);
    const lane = vacant < 0 ? lanes.length : vacant;
    lanes[lane] = sha;
    return lane;
  }
  return items.map((commit) => {
    const lane = reserve(commit.sha);
    const tracks = lanes.map(Boolean);
    lanes[lane] = undefined;
    return { ...commit, tracks, lane, edges: commit.parents.map((parent) => ({ parent, lane: reserve(parent) })) };
  });
}

export function textGraph(items: GitCommit[]) {
  return commitLanes(items)
    .map((row) => {
      const tracks = row.tracks.map((live, lane) =>
        lane === row.lane ? (row.parents.length > 1 ? '◆' : '●') : live ? '│' : ' ',
      );
      const parents = row.parents.map((sha) => sha.slice(0, 8)).join(' ');
      return (
        tracks.join(' ') +
        '  ' +
        row.sha.slice(0, 8) +
        '  ' +
        row.date.slice(0, 10) +
        '  ' +
        row.title +
        (parents ? '  ← ' + parents : '')
      );
    })
    .join('\n');
}
