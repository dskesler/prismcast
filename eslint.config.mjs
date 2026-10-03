/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Linting configuration for PrismCast.
 */
import hbPluginUtils from "homebridge-plugin-utils/eslint";

/* Project-local ESLint rules. Each rule enforces a convention specific to this codebase that has caused regressions in the past:
 *
 * - no-helpers-in-types: prevents test helpers from being placed under src/types/. The types/ folder is for type definitions only; test helpers belong
 *   adjacent to the production module that constructs the value (e.g., src/streaming/registry.helpers.ts next to src/streaming/registry.ts). Fires on any
 *   file whose path matches src/types/<...>/*.helpers.ts or src/types/<...>/*.helpers.test.ts.
 *
 * - testing-helpers-barrel-only: enforces a single canonical import path for the cross-cutting testing helpers. Tests outside src/testing/ must import from
 *   the barrel (src/testing.helpers.ts), not from individual submodules. The submodules are implementation details; pinning callers to the barrel keeps a
 *   single canonical entry point and lets the implementation evolve without rippling through the suite.
 *
 * - clock-port: time is read and timers are armed through the library's Clock port. A direct wall-clock read, a platform timer call, a platform timeout
 *   signal, a platform timer handle held as a type, or an import of node:timers/promises outside a page-context callback is a completeness gap, because it is
 *   a moment a test cannot drive and production cannot redirect. The page-callback exemption is decided by ancestry - a read inside the callback the three
 *   page methods take as their first argument, or the one evaluateWithAbort takes as its second, runs in the browser rather than in Node - and the
 *   client-script and helper files are exempt by path.
 *
 * Every project-local rule is exported (named) so unit tests under src/ can import it and exercise the rule logic via ESLint's RuleTester. The default
 * export of this file is the full flat config; the named `rules` export is just the rule definitions, decoupled from homebridge-plugin-utils for
 * testability.
 */
export const rules = {

  "clock-port": {

    create(context) {

      // The callback forms that hand a function to the page: a member call whose property is one of these takes the page function as its first argument, and the
      // project's own evaluateWithAbort takes it as its second. A read inside such a callback runs in the browser, never in Node, so it is never a port consumer.
      const pageMethods = new Set([ "evaluate", "evaluateHandle", "evaluateOnNewDocument" ]);
      const timerGlobals = new Set([ "clearInterval", "clearTimeout", "setInterval", "setTimeout" ]);

      const isPageCallback = (fn) => {

        const call = fn.parent;

        if(!call || (call.type !== "CallExpression")) {

          return false;
        }

        const index = call.arguments.indexOf(fn);
        const callee = call.callee;

        if((callee.type === "MemberExpression") && !callee.computed && (callee.property.type === "Identifier") && pageMethods.has(callee.property.name)) {

          return index === 0;
        }

        return (callee.type === "Identifier") && (callee.name === "evaluateWithAbort") && (index === 1);
      };

      // Walks upward from a node to the file's root. The walk continues past every function boundary, because a helper defined inside a page callback is still
      // page code, and stops only at the first function that is itself a page callback argument.
      const insidePageCallback = (node) => {

        for(let current = node.parent; current; current = current.parent) {

          if(((current.type === "ArrowFunctionExpression") || (current.type === "FunctionExpression")) && isPageCallback(current)) {

            return true;
          }
        }

        return false;
      };

      const report = (node, messageId, data = {}) => {

        if(!insidePageCallback(node)) {

          context.report({ data, messageId, node });
        }
      };

      const isMemberCall = (node, objectName, propertyName) => (node.callee.type === "MemberExpression") && !node.callee.computed &&
        (node.callee.object.type === "Identifier") && (node.callee.object.name === objectName) && (node.callee.property.type === "Identifier") &&
        (node.callee.property.name === propertyName);

      return {

        CallExpression(node) {

          // AbortSignal.any is deliberately absent: it composes signals somebody else armed and reads no time of its own, so it is not a port consumer.
          if(isMemberCall(node, "AbortSignal", "timeout")) {

            report(node, "abortTimeout");
          }

          if(isMemberCall(node, "Date", "now")) {

            report(node, "dateNow");
          }

          if(isMemberCall(node, "performance", "now")) {

            report(node, "performanceNow");
          }
        },

        ImportDeclaration(node) {

          if((node.source.value === "node:timers/promises") || (node.source.value === "timers/promises")) {

            context.report({ messageId: "timersImport", node });
          }
        },

        NewExpression(node) {

          if((node.callee.type === "Identifier") && (node.callee.name === "Date") && (node.arguments.length === 0)) {

            report(node, "newDate");
          }
        },

        // The global timer functions are matched by scope resolution rather than by name, so a registry's or a clock's own setTimeout member never matches: only an
        // identifier that resolves to the global binding, or to nothing at all, is the platform timer. A locally declared binding of the same name is a shadow and
        // stays out of the report. A reference from a type query (ReturnType<typeof setTimeout>) is the platform handle held as a type, and gets its own message.
        "Program:exit"(node) {

          const globalScope = context.sourceCode.getScope(node);
          const flag = (reference) => {

            const identifier = reference.identifier;
            const parent = identifier.parent;

            if((parent?.type === "MemberExpression") && (parent.property === identifier)) {

              return;
            }

            report(identifier, (parent?.type === "TSTypeQuery") ? "timerHandleType" : "globalTimer", { name: identifier.name });
          };

          for(const variable of globalScope.variables) {

            if(timerGlobals.has(variable.name) && (variable.defs.length === 0)) {

              for(const reference of variable.references) {

                flag(reference);
              }
            }
          }

          for(const reference of globalScope.through) {

            if(timerGlobals.has(reference.identifier.name)) {

              flag(reference);
            }
          }
        }
      };
    },
    meta: {

      docs: {

        description: "Time is read and timers are armed through the library's Clock port. Direct wall-clock reads and platform timer calls outside a " +
          "page-context callback are a completeness gap."
      },
      messages: {

        abortTimeout: "Bound a wait through the Clock port (timeoutSignal in utils/delay.ts, which carries the caller's own reason), never AbortSignal.timeout().",
        dateNow: "Read the instant through the Clock port (clock.now() or a now parameter), never Date.now(). A read inside a page.evaluate callback is exempt " +
          "by its ancestry.",
        globalTimer: "Arm and clear timers through the Clock port (clock.schedule, clock.delay, or a TimerRegistry), never the platform's {{name}}.",
        newDate: "Build a Date from an instant the Clock port supplied (new Date(clock.now())), never from the argument-less constructor.",
        performanceNow: "Measure elapsed time through the Clock port (startTimer(clock) or clock.now()), never performance.now().",
        timerHandleType: "Hold an armed timer as the Clock port's Disposable handle or under a TimerRegistry key, never as the platform's {{name}} handle type.",
        timersImport: "Sleep through the Clock port (clock.delay or the delay policy in utils/delay.ts), never node:timers/promises."
      },
      schema: [],
      type: "problem"
    }
  },
  "no-helpers-in-types": {

    create(context) {

      return {

        Program(node) {

          // ESLint 9 exposes the filename via context.filename; older builds expose getFilename(). We support both because the project may pin different
          // ESLint majors over time.
          const filename = context.filename ?? (typeof context.getFilename === "function" ? context.getFilename() : "");

          if((/\/src\/types\/.*\.helpers(\.test)?\.ts$/).test(filename)) {

            context.report({ messageId: "forbidden", node });
          }
        }
      };
    },
    meta: {

      docs: {

        description: "Test helpers must not live under src/types/. Place them adjacent to the production module that constructs the value."
      },
      messages: {

        forbidden: "Test helpers (*.helpers.ts) and their tests must not live under src/types/. Move this file adjacent to the production module that " +
          "constructs the value (e.g., a ResolvedChannel factory belongs in src/config/userChannels.helpers.ts, not src/types/channels.helpers.ts)."
      },
      schema: [],
      type: "problem"
    }
  },
  "testing-helpers-barrel-only": {

    create(context) {

      return {

        ImportDeclaration(node) {

          const value = node.source.value;

          if(typeof value !== "string") {

            return;
          }

          // Match any import path that ends with /testing/<name>.helpers.ts or /testing/<name>.helpers.test.ts, regardless of how many ../ levels precede
          // it (so the rule fires equally on "../testing/parity.helpers.ts", "../../testing/parity.helpers.ts", etc.). The barrel itself,
          // "../testing.helpers.ts", does NOT match this pattern (no slash after "testing").
          if((/(?:^|\/)testing\/[^/]+\.helpers(\.test)?\.ts$/).test(value)) {

            context.report({ data: { importPath: value }, messageId: "barrelOnly", node });
          }
        }
      };
    },
    meta: {

      docs: {

        description: "Cross-cutting testing helpers must be imported from the barrel (testing.helpers.ts), not from individual src/testing/ submodules."
      },
      messages: {

        barrelOnly: "Import testing helpers from '../testing.helpers.ts' (the barrel), not directly from '{{importPath}}'. The src/testing/ submodules " +
          "are implementation details of the barrel; pinning all callers to the barrel keeps a single canonical entry point and lets the implementation " +
          "evolve without rippling through the suite."
      },
      schema: [],
      type: "problem"
    }
  }
};

const prismcastPlugin = { rules };

export default hbPluginUtils({

  allowDefaultProject: ["eslint.config.mjs"],

  /* Project-level ESLint overrides applied after the homebridge-plugin-utils base. The block scoped to the TypeScript sources under src and test defers
   * dot-notation to the TS-aware rule so it stops fighting the tsconfig's noPropertyAccessFromIndexSignature - bracket access on index-signature
   * properties is required by tsc and must be allowed by ESLint. The block scoped to the test files relaxes two rules: describe and test from node:test
   * return Promise<void> by design (no-floating-promises would fire on every test invocation), and tests own their preconditions and use `value!` when
   * reading out fixture-shaped data (no-non-null-assertion). The block scoped to the src types directory enforces the project-local helper-location rule
   * against everything under it. The block scoped to the src and test TypeScript sources, excluding the testing helpers' own implementation directory,
   * enforces barrel-only imports for the testing helpers, since that directory is itself the barrel's implementation and must import from its own submodules.
   */
  extraConfigs: [
    {

      files: [ "src/**/*.ts", "test/**/*.ts" ],
      rules: {

        "@typescript-eslint/dot-notation": [ "warn", { allowIndexSignaturePropertyAccess: true } ],
        "dot-notation": "off"
      }
    },
    {

      files: [ "src/**/*.test.ts", "test/**/*.test.ts" ],
      rules: {

        "@typescript-eslint/no-floating-promises": "off",
        "@typescript-eslint/no-non-null-assertion": "off"
      }
    },
    {

      files: ["src/types/**/*.ts"],
      plugins: { prismcast: prismcastPlugin },
      rules: {

        "prismcast/no-helpers-in-types": "error"
      }
    },
    {

      files: [ "src/**/*.ts", "test/**/*.ts" ],
      ignores: [ "src/testing/**/*.ts", "src/testing.helpers.ts" ],
      plugins: { prismcast: prismcastPlugin },
      rules: {

        "prismcast/testing-helpers-barrel-only": "error"
      }
    },
    {

      files: ["src/**/*.ts"],
      ignores: [ "src/**/*.helpers.ts", "src/**/*.test.ts", "src/routes/root/content.ts", "src/routes/root/scripts/**/*.ts", "src/testing/**/*.ts",
        "src/testing.helpers.ts" ],
      plugins: { prismcast: prismcastPlugin },
      rules: {

        "prismcast/clock-port": "error"
      }
    }
  ],

  js: ["eslint.config.mjs"],
  ts: [ "src/**/*.ts", "test/**/*.ts" ]
});
