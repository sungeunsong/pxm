export function countPlaywrightTests(report) {
  let count = 0;
  const visitSuite = (suite) => {
    for (const spec of suite?.specs || []) {
      for (const test of spec?.tests || []) {
        if ((test?.results || []).length > 0) count += 1;
      }
    }
    for (const child of suite?.suites || []) visitSuite(child);
  };
  for (const suite of report?.suites || []) visitSuite(suite);
  return count;
}
