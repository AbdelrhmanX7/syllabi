/**
 * Standing rules every AI that works for the student follows, wherever it connects from (the MCP
 * server's instructions, the tools that make documents). One place, so they never drift apart.
 */

/** A line that is only this starts a new page in a markdown document (see markdownToHtml). */
export const PAGE_BREAK_MARK = "\\newpage";

/**
 * Worksheets: one question per page. The student answers by hand on a tablet, under the question —
 * two questions on a page leave no room to work.
 */
export const QUESTION_PAGES_RULE =
  "Worksheets and question sets (a PDF or pages with questions the student will work on by hand): put EACH question on its own page — the question at the top and the rest of that page left empty for handwritten work. Never two questions on one page (a question's own parts a), b), c) stay together), and no answer or solution on a question's page; if answers are wanted they go on separate pages at the end. In markdown, a line containing only \\newpage starts a new page; in html, put style=\"break-before: page\" on each question after the first.";
