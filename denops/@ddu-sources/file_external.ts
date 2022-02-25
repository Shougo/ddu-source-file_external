import { BaseSource, Item } from "https://deno.land/x/ddu_vim@v0.12.2/types.ts";
import { Denops, fn } from "https://deno.land/x/ddu_vim@v0.12.2/deps.ts";
import { ActionData } from "https://deno.land/x/ddu_kind_file@v0.2.0/file.ts";
import { relative, resolve } from "https://deno.land/std@0.125.0/path/mod.ts";
import { BufReader } from "https://deno.land/std@0.125.0/io/buffer.ts";
import { abortable } from "https://deno.land/std@0.127.0/async/abortable.ts";

type Params = {
  cmd: string[];
  path: string;
  updateItems: number;
};

async function* iterLine(reader: Deno.Reader): AsyncIterable<string> {
  const buffered = new BufReader(reader);
  while (true) {
    const line = await buffered.readString("\n");
    if (!line) {
      break;
    }
    yield line;
  }
}

export class Source extends BaseSource<Params> {
  kind = "file";

  gather(args: {
    denops: Denops;
    sourceParams: Params;
  }): ReadableStream<Item<ActionData>[]> {
    const abortController = new AbortController();
    const { denops, sourceParams } = args;
    return new ReadableStream({
      async start(controller) {
        let root = await fn.expand(denops, sourceParams.path) as string;
        if (root == "") {
          root = await fn.getcwd(denops) as string;
        }

        if (!args.sourceParams.cmd.length) {
          return;
        }

        // controller.close();
        let items: Item<ActionData>[] = [];
        const updateItems = sourceParams.updateItems;

        const proc = Deno.run({
          cmd: [...sourceParams.cmd, root],
          stdout: "piped",
          stderr: "piped",
          cwd: root,
        });

        try {
          for await (
            const line of abortable(
              iterLine(proc.stdout),
              abortController.signal,
            )
          ) {
            const path = line.trim();
            if (!path.length) continue;
            const fullPath = resolve(root, path);
            items.push({
              word: relative(root, fullPath),
              action: {
                path: fullPath,
              },
            });
            if (items.length >= updateItems) {
              controller.enqueue(items);
              items = [];
            }
          }
          if (items.length) {
            controller.enqueue(items);
          }
        } catch (e: unknown) {
          if (e instanceof DOMException) {
            proc.kill("SIGTERM");
          } else {
            console.error(e);
          }
        } finally {
          const [status, stderr] = await Promise.all([
            proc.status(),
            proc.stderrOutput(),
          ]);
          proc.close();
          if (!status.success) {
            console.error(new TextDecoder().decode(stderr));
          }
          controller.close();
        }
      },

      cancel(reason): void {
        abortController.abort(reason);
      },
    });
  }

  params(): Params {
    return {
      cmd: [],
      path: "",
      updateItems: 30000,
    };
  }
}