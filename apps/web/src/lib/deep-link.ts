/**
 * 화면 주소(hash)에 대상 식별자를 담는다.
 *
 *   #/inbox?task=<task_id>               결재 상세
 *   #/my-requests?request=<instance_id>  내 요청 상세
 *   #/designer?workflow=<template_id>    워크플로우 설계
 *   #/designer?instance=<instance_id>    실행 추적
 *
 * 새로고침하거나 주소를 전달해도 같은 대상이 열리고, 오류 안내·운영 화면·알림에서
 * 목록을 뒤지지 않고 곧장 이동할 수 있게 하기 위해서다.
 */
export type DeepLinkParam = 'task' | 'request' | 'workflow' | 'instance';

type Params = Partial<Record<DeepLinkParam, string | null | undefined>>;

export function hashFor(route: string, params: Params = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return `#/${route}${text ? `?${text}` : ''}`;
}

export function readHashRoute(): string {
  if (typeof window === 'undefined') return '';
  return window.location.hash.replace(/^#\/?/, '').split('?')[0];
}

export function readHashParam(name: DeepLinkParam): string | null {
  if (typeof window === 'undefined') return null;
  const query = window.location.hash.split('?')[1] || '';
  const value = new URLSearchParams(query).get(name);
  return value && value.trim() ? value : null;
}

/** 화면 안에서 대상을 바꿀 때 쓴다. 뒤로 가기 기록을 늘리지 않는다. */
export function replaceHash(route: string, params: Params = {}): void {
  const next = hashFor(route, params);
  if (window.location.hash !== next) window.history.replaceState(null, '', next);
}
