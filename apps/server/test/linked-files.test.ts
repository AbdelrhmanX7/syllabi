import assert from "node:assert/strict";
import { test } from "node:test";
import { linkedFileIds } from "../src/services/study/canvas-sync.service";

test("files linked from a lesson's text are found once each, with the link's words; pictures are not files to fetch", () => {
  const html =
    '<p>Print <a class="instructure_file_link" title="notes.pdf" href="https://school.test/courses/7/files/101?wrap=1" data-api-endpoint="x"><strong>these blank</strong> guided notes</a>.</p>' +
    '<img src="https://school.test/courses/7/files/55/preview" alt="graph">' +
    '<a href="/courses/7/files/102/download?download_frd=1">the solutions here.&nbsp;</a> <a href="https://school.test/courses/7/files/101">again</a> <a href="https://school.test/courses/7/pages/x">a page</a>';
  const found = linkedFileIds([
    { item: "lesson-1", html },
    { item: "lesson-2", html: '<a href="/courses/7/files/102">later</a>' },
  ]);
  assert.deepEqual([...found], [
    [101, { item: "lesson-1", text: "these blank guided notes" }],
    [102, { item: "lesson-1", text: "the solutions here." }],
  ]);
});
