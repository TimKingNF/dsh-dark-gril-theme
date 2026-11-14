# 素材

`assets/*.webm` 不入库（原始素材 22 段合计 127MB），从本机取：

```bash
cp /mnt/c/Users/TimKing/Downloads/object-live-states/{idle,thinking,acting,approval,done,done-soft,done-confirm}.webm assets/
```

规格：VP9、2560×1392、24fps、3.08–6.04s、单段 5–6MB。
文件名会被状态机直接引用，改名要同步改 `runtime/bg.js` 的状态映射。
