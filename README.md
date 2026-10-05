# usage-band

Claude Code mod: 입력창 바로 위에 구독 사용량(5h / 7d 남은 %, 리셋까지 남은 시간)과 컨텍스트 사용률(ctx %, 토큰)을 한 줄로 실시간 표시합니다.

- 데스크톱 Code 탭: 아이콘 + SVG 게이지 바, 항목 사이 `│` 구분선
- 터미널: `5h:77% (02:13) | 7d:60% (3 12:00) | ctx 42% (84K / 200K)`

## 사용

```bash
claude --plugin-dir <이 폴더의 상위 폴더>
```

또는 환경변수 `CLAUDE_CODE_PLUGIN_DIRS`에 상위 폴더 경로를 추가합니다.
