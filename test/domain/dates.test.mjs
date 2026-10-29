import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  assertDate,
  diffDays,
  eachDate,
  isValidDate,
  lastNDates,
  weekdayIndex,
  DomainError,
} from '../../server/domain/index.mjs';

test('日期：严格校验真实日历日（修 v1 D5 静默滚转）', () => {
  assert.equal(isValidDate('2026-02-28'), true);
  assert.equal(isValidDate('2024-02-29'), true, '2024 是闰年');
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('2026-02-31'), false, 'v1 会静默滚到 3 月，这里必须拒绝');
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('2026-1-1'), false, '必须是两位月份');
  assert.equal(isValidDate(''), false);
  assert.equal(isValidDate(null), false);

  assert.throws(() => assertDate('2026-02-31', 'asOf'), (e) => {
    assert.ok(e instanceof DomainError);
    assert.equal(e.code, 'VALIDATION_ERROR');
    assert.match(e.message, /asOf/);
    return true;
  });
});

test('日期：加减/差值/星期（UTC，无时区漂移）', () => {
  assert.equal(addDays('2026-10-29', 3), '2026-11-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(diffDays('2026-10-01', '2026-10-29'), 28);
  // 2026-10-29 是周四（4）
  assert.equal(weekdayIndex('2026-10-29'), 4);
  assert.equal(weekdayIndex('2018-12-08'), 6, '2018-12-08 是周六');
  assert.equal(weekdayIndex('2018-12-09'), 0, '2018-12-09 是周日');
});

test('日期：窗口区间含端点', () => {
  assert.deepEqual(lastNDates('2026-10-29', 3), ['2026-10-27', '2026-10-28', '2026-10-29']);
  assert.equal(lastNDates('2026-10-29', 15).length, 15);
  assert.deepEqual(eachDate('2026-10-28', '2026-10-29'), ['2026-10-28', '2026-10-29']);
  assert.deepEqual(eachDate('2026-10-29', '2026-10-28'), []);
});
