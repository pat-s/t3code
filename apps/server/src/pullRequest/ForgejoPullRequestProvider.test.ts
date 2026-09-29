import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ForgejoCli, ForgejoCliError, type ForgejoApiInput } from "../sourceControl/ForgejoCli.ts";
import { make } from "./ForgejoPullRequestProvider.ts";

const reference = {
  cwd: "/repo",
  repository: "acme/project",
  host: "https://forgejo.example.com",
  number: 42,
};
const output = (stdout: string) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

describe("Forgejo merge branch deletion", () => {
  for (const mergeMethod of [undefined, "merge", "squash", "rebase"] as const) {
    it.effect.each([true, false, undefined])(
      `respects repository deletion setting %s when merging with ${mergeMethod ?? "the default"}`,
      (deleteBranch) =>
        Effect.gen(function* () {
          const requests: ForgejoApiInput[] = [];
          const provider = yield* make.pipe(
            Effect.provide(
              Layer.mock(ForgejoCli)({
                api: (input) => {
                  requests.push(input);
                  return Effect.succeed(
                    output(
                      input.path === "repos/acme/project"
                        ? JSON.stringify({
                            full_name: "acme/project",
                            default_delete_branch_after_merge: deleteBranch,
                          })
                        : "",
                    ),
                  );
                },
              }),
            ),
          );

          yield* provider.runAction({
            ...reference,
            action: "merge",
            ...(mergeMethod === undefined ? {} : { mergeMethod }),
          });

          expect(requests).toHaveLength(2);
          expect(requests[0]).toMatchObject({
            ...reference,
            path: "repos/acme/project",
          });
          expect(requests[0]?.method ?? "GET").toBe("GET");
          expect(requests[1]).toMatchObject({
            ...reference,
            path: "repos/acme/project/pulls/42/merge",
            method: "POST",
            body: {
              Do: mergeMethod ?? "merge",
              delete_branch_after_merge: deleteBranch ?? false,
            },
          });
        }),
    );
  }

  it.effect.each(["request failure", "invalid response", "truncated response"] as const)(
    "does not merge when reading repository settings fails: %s",
    (failure) =>
      Effect.gen(function* () {
        const requests: ForgejoApiInput[] = [];
        const provider = yield* make.pipe(
          Effect.provide(
            Layer.mock(ForgejoCli)({
              api: (input) => {
                requests.push(input);
                if (failure === "request failure") {
                  return Effect.fail(
                    new ForgejoCliError({
                      command: "fj",
                      cwd: reference.cwd,
                      detail: "Repository settings unavailable",
                    }),
                  );
                }
                return Effect.succeed({
                  ...output(
                    JSON.stringify({
                      full_name: "acme/project",
                      default_delete_branch_after_merge:
                        failure === "invalid response" ? "true" : true,
                    }),
                  ),
                  stdoutTruncated: failure === "truncated response",
                });
              },
            }),
          ),
        );

        const result = yield* Effect.result(provider.runAction({ ...reference, action: "merge" }));

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "PullRequestProviderError", provider: "forgejo" },
        });
        expect(requests.map((request) => request.path)).toEqual(["repos/acme/project"]);
      }),
  );
});
