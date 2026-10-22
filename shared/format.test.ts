import { describe, expect, it } from 'vitest';
import { day, dayTime, greeting, sessionLabel, time } from './format.ts';

// 2026-10-23 is a Friday. PKT = UTC+5.
const fri0041 = new Date('2026-10-22T19:41:00Z'); // Fri Oct 23, 00:41 PKT
const fri1500 = new Date('2026-10-23T10:00:00Z'); // Fri Oct 23, 15:00 PKT
const thuClose = '2026-10-22T10:49:00Z'; // Thu Oct 22, 15:49 PKT

describe('day', () => {
  it('relative words near today', () => {
    expect(day('2026-10-23', fri1500)).toBe('Today');
    expect(day('2026-10-22', fri1500)).toBe('Yesterday');
    expect(day('2026-10-24', fri1500)).toBe('Tomorrow');
    expect(day('2026-10-20', fri1500)).toBe('Tue');
    expect(day('2026-10-27', fri1500)).toBe('Tue');
  });
  it('month and day this year, with the year otherwise', () => {
    expect(day('2026-10-05', fri1500)).toBe('Oct 5');
    expect(day('2025-10-05', fri1500)).toBe('Oct 5, 2025');
  });
  it('reads timestamps in PKT', () => {
    expect(day('2026-10-22T19:30:00Z', fri1500)).toBe('Today'); // 00:30 PKT on Friday
    expect(day(null)).toBe('no date');
  });
});

describe('time and dayTime', () => {
  it('formats in PKT', () => {
    expect(time(thuClose)).toBe('3:49 PM');
    expect(dayTime(thuClose, fri1500)).toBe('Yesterday 3:49 PM');
  });
});

describe('sessionLabel', () => {
  it('says Today only for today\'s session', () => {
    expect(sessionLabel('2026-10-23T08:00:00Z', fri1500)).toBe('Today');
  });
  it('a Thursday close after midnight is the last session', () => {
    expect(sessionLabel(thuClose, fri0041)).toBe('Last session (Thu)');
  });
  it('weekends never say Today', () => {
    expect(sessionLabel('2026-10-24T08:00:00Z', new Date('2026-10-24T09:00:00Z'))).toBe('Last session (Sat)');
  });
});

describe('greeting', () => {
  it('by PKT hour', () => {
    expect(greeting(fri0041)).toBe('Good evening');
    expect(greeting(new Date('2026-10-23T02:00:00Z'))).toBe('Good morning'); // 07:00
    expect(greeting(fri1500)).toBe('Good afternoon');
    expect(greeting(new Date('2026-10-23T13:00:00Z'))).toBe('Good evening'); // 18:00
  });
});
