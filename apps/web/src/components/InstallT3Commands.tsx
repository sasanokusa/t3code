import { T } from "gt-react";
import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

/**
 * Setup steps for another computer: install `t3`, then run `command`.
 * Hardened fork: no upstream installers; `t3` comes from a source build of the fork.
 */
export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <CommandBlock command="git clone https://github.com/sasanokusa/t3code && cd t3code && vp i && vp run build:desktop" />
      <p className="text-xs text-muted-foreground">
        <T>Then</T>
      </p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        <T>
          Skip the install if you already have <code className="font-mono">t3</code>. If{" "}
          <code className="font-mono">t3</code> is not found after installing, add the folder the
          installer names to your PATH.
        </T>
      </p>
    </div>
  );
}
