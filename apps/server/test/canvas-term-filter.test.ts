/**
 * Which Canvas courses count as "this term" (services/study/canvas-mapping.ts). A school that does
 * not date its terms, or a term that has not started yet, must not leave the app with no classes.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { selectCurrentTermCourses } from "../src/services/study/canvas-mapping";

const now = new Date("2026-11-16T12:00:00Z");
const term = (id: number, start: string | null, end: string | null) => ({ id, name: `T${id}`, start_at: start, end_at: end });
const fall = term(1, "2026-08-20T00:00:00Z", "2026-12-18T00:00:00Z");
const spring = term(2, "2026-01-10T00:00:00Z", "2026-05-20T00:00:00Z");
const next = term(3, "2027-01-10T00:00:00Z", "2027-05-20T00:00:00Z");
const later = term(4, "2027-08-20T00:00:00Z", "2027-12-18T00:00:00Z");
const undated = term(9, null, null);
const ids = (list: { id: number }[]) => list.map((c) => c.id);

describe("selectCurrentTermCourses", () => {
  test("keeps the dated term that contains today and drops undated shells", () => {
    const courses = [{ id: 1, term: fall }, { id: 2, term: spring }, { id: 3, term: undated }];
    assert.deepEqual(ids(selectCurrentTermCourses(courses, now)), [1]);
  });

  test("between terms keeps the most recent one", () => {
    const courses = [{ id: 1, term: spring }, { id: 2, term: term(5, "2025-08-20T00:00:00Z", "2025-12-18T00:00:00Z") }];
    assert.deepEqual(ids(selectCurrentTermCourses(courses, new Date("2026-07-01T00:00:00Z"))), [1]);
  });

  test("a school with no dated terms keeps every course that has not ended", () => {
    const courses = [
      { id: 1, term: undated },
      { id: 2, term: undated, end_at: "2027-06-01T00:00:00Z" },
      { id: 3, term: undated, end_at: "2025-06-01T00:00:00Z" },
      { id: 4, access_restricted_by_date: true },
      { id: 5 },
    ];
    assert.deepEqual(ids(selectCurrentTermCourses(courses, now)), [1, 2, 5]);
  });

  test("when every dated term is still ahead, keeps the one that starts soonest", () => {
    const courses = [{ id: 1, term: later }, { id: 2, term: next }, { id: 3, term: next }, { id: 4, term: undated }];
    assert.deepEqual(ids(selectCurrentTermCourses(courses, now)), [2, 3]);
  });

  test("no courses, no classes", () => {
    assert.deepEqual(selectCurrentTermCourses([], now), []);
  });
});
