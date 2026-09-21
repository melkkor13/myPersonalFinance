# Task: Toolchain Preflight

## Status
COMPLETED

## Description
Confirm the build environment is usable before any file is written. Fails fast rather than
letting a later task fail confusingly.

## Inputs
- requirements.md § E1, E2, Q3, Q5

## Steps
1. Assert `node -v` >= 22.13.0 (eslint@10 floor, C14). Local was v22.18.0.
2. Assert the npm registry authenticates: `npm view fastify version` returns a version, not E401.
3. Assert `npm -v` >= 10.
4. If registry auth fails, STOP and report that the CodeArtifact token needs refreshing.

## Expected Output
A short pass/fail report. No files created.

## Verification
All three assertions pass.

## Dependencies
None
