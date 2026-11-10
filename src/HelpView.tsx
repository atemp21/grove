import { Box, Text } from "ink";

type Entry = [keys: string, name: string, what: string];

const SECTIONS: { title: string; about?: string; entries: Entry[] }[] = [
  {
    title: "Sessions",
    about: "each agent works on its own branch, in its own folder",
    entries: [
      ["n", "new", "start an agent on a new branch (or an existing one)"],
      ["enter", "attach", "jump into the agent's terminal; ctrl-b d comes back"],
      ["d", "diff", "see what the agent changed, new files included"],
      ["D", "full patch", "the whole diff in git's pager"],
      ["m", "merge", "merge the branch into the base branch"],
      ["p", "PR", "push the branch and open a pull request"],
      ["x / X", "remove", "delete the folder (and the branch, if merged); X also discards uncommitted work"],
    ],
  },
  {
    title: "Fan-out",
    about: "try one task several ways and keep the best",
    entries: [
      ["f", "fan out", "start the same task in 2–5 agents at once"],
      ["c", "compare", "line the attempts up side by side"],
      ["t", "test all", "in compare: run the tests in every attempt"],
      ["w", "keep", "in compare: keep the selected attempt, delete the others"],
    ],
  },
  {
    title: "Preview",
    about: "one extra folder with every agent's work merged, to try it all together",
    entries: [
      ["v", "preview", "create the preview, or open a shell in it"],
      ["space", "in / out", "include the selected agent's work in the preview, or leave it out"],
      ["V", "drop preview", "delete the preview folder; the agents' own folders are untouched"],
    ],
  },
  {
    title: "Other",
    entries: [
      ["j / k", "move", "arrow keys work too"],
      ["r", "refresh", "re-read every session now"],
      ["u", "update base", "pull the base branch from its remote now (also every 2 minutes; fast-forward only)"],
      ["q", "quit", "sessions keep running in tmux"],
    ],
  },
];

const KEY_WIDTH = Math.max(...SECTIONS.flatMap((s) => s.entries.map(([k]) => k.length))) + 2;
const NAME_WIDTH = Math.max(...SECTIONS.flatMap((s) => s.entries.map(([, n]) => n.length))) + 2;

export function HelpView() {
  return (
    <Box flexDirection="column">
      {SECTIONS.map((section, i) => (
        <Box key={section.title} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
          <Text wrap="truncate-end">
            <Text bold>{section.title}</Text>
            {section.about && <Text dimColor>  {section.about}</Text>}
          </Text>
          {section.entries.map(([keys, name, what]) => (
            <Box key={keys}>
              <Box width={KEY_WIDTH + 2} flexShrink={0} paddingLeft={2}>
                <Text color="white">{keys}</Text>
              </Box>
              <Box width={NAME_WIDTH} flexShrink={0}>
                <Text>{name}</Text>
              </Box>
              <Text dimColor wrap="truncate-end">{what}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
