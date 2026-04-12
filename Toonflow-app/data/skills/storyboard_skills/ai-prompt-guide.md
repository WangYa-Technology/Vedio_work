---
name: ai_prompt_guide
description: AI提示词写法指南：万能公式、防崩注意事项、六大平台专项写法（Seedance/巨日禄/即梦/可灵/Midjourney/Runway）
---

# AI提示词写法指南

## 万能公式（防崩核心）

所有优质AI视频/图像提示词遵循以下结构：

```
主体 + 动作 + 场景 + 光影 + 镜头语言 + 风格 + 画质 + 约束
```

**每一层都不能少，尤其是"约束"——这是防止画面崩坏变形的关键。**

### 公式示例（雪中武将）

```
【主体】三十多岁的中国男性，面容刚毅沧桑，头戴毡笠，身穿破旧棉袄，手持长枪，腰悬酒葫芦
【动作】独自伫立在风雪中，寒风吹动衣角，眼神望向远方
【场景】沧州草料场，大雪覆盖的草垛，破旧木栅栏，漫天飞雪
【光影】阴天漫射光，无强光源，整体灰白冷调，无阴影边缘
【镜头语言】中景推近，缓慢推进至近景
【风格】中国水墨动漫风格，ink wash painting mixed with anime cel-shading
【画质】高清，线条清晰，水墨晕染效果
【约束】人物结构正常，面部清晰不变形，五官稳定，比例自然，动作不僵硬，画面稳定不抖动
```

---

## 防崩注意事项

**动作描述写"慢"：** 越慢越稳，越快越容易崩。
- ✅ 缓慢推近、轻柔转身、逐渐抬头
- ❌ 高速移动、剧烈扭转、夸张动作

**避免主观词：** AI无法理解抽象描述。
- ❌ 漂亮、帅气、很酷、感人、震撼
- ✅ 面容刚毅沧桑、嘴角微扬、泪水滑落脸颊

**禁止在AI提示词里出现的内容：**
- 角色的中文真实姓名（"林冲"AI不认识，用描述词代替）
- 过于抽象的情绪词（用具体的视觉/肢体描述代替）
- 叙事性语言（"他突然意识到..."→换成画面描述）

---

## 关键词速查表

### 镜头运动
| 效果 | 中文关键词 | 英文关键词 |
|------|-----------|-----------|
| 推近 | 推镜头/缓慢推近/急速推进 | push in / slow push in |
| 拉远 | 拉镜头/逐渐拉远 | pull out / slow pull back |
| 横移 | 左摇/右摇/横移 | pan left / pan right / lateral tracking |
| 跟随 | 跟随镜头/跟拍 | follow shot / tracking shot |
| 环绕 | 环绕镜头/360度旋转 | orbit shot / 360 rotation |
| 升降 | 升镜头/降镜头/俯冲 | crane up / crane down / dive shot |
| 特效 | 希区柯克变焦/一镜到底 | dolly zoom / one-take shot |
| 手持 | 手持晃动 | handheld camera shake |

### 景别
| 中文 | 英文 |
|------|------|
| 远景 | wide shot / establishing shot |
| 全景 | full shot |
| 中景 | medium shot |
| 近景 | medium close-up |
| 特写 | close-up shot |
| 大特写 | extreme close-up |
| 低角仰拍 | low angle upward shot |
| 俯拍 | overhead shot / bird's eye view |

### 光影氛围
| 中文 | 英文 |
|------|------|
| 逆光/侧逆光 | backlit, contre-jour, rim light |
| 侧光 | side lighting, Rembrandt light |
| 顶光 | top lighting |
| 体积光/丁达尔 | volumetric light, god rays, Tyndall effect |
| 剪影 | silhouette |
| 轮廓光 | outline light, edge light |

### 情绪氛围词
| 中文 | 英文 |
|------|------|
| 压抑、阴冷 | oppressive, cold, tense, suffocating |
| 孤寂、萧索 | desolate, lonely, melancholic |
| 温暖、温情 | warm, tender, heartwarming |
| 爽感、燃 | exhilarating, epic, triumphant |
| 悬疑、神秘 | mysterious, suspenseful, eerie |
| 愤怒、决绝 | furious, relentless, cold determination |
| 震撼、震惊 | awestruck, stunned, overwhelmed |

### 色调风格
| 风格类型 | 关键词 |
|---------|-------|
| 现代都市夜景 | neon-lit cityscape, urban cinematic, blue-orange grade |
| 阴冷医院 | cold sterile lighting, blue-green tones, clinical |
| 水墨古装 | ink wash painting, Chinese brushwork, monochrome with accent colors |
| 古装修仙 | ancient Chinese xianxia, ethereal mist, golden divine light |
| 回闪/回忆 | desaturated, low contrast, faded memory, grainy |
| 爽感高潮 | vibrant, high contrast, dramatic god rays, epic |

---

## 平台专项提示词写法

### 🎬 Seedance 2.0（首尾帧模式）

**最适合：** 历史武侠、水墨风格、有角色一致性参考图的项目

**提示词结构（时间轴格式）：**
```
[风格]，[时长]秒，[画幅]，[整体氛围]

[0-3秒]：[镜头运动]，[画面描述]，[氛围]
[3-6秒]：[镜头运动]，[动作描述]，[情绪]
...
[12-15秒]：[镜头运动]，[收尾画面]，[余韵]

【声音】[配乐] + [音效] + [对白]
【参考】@图片1 首帧，@图片2 尾帧，@图片N 参考
```

**Seedance 特有运镜词：**
- 缓慢推进镜头 / slow push in
- 从低角度仰拍 / low angle shot looking up
- 镜头从模糊到清晰 / rack focus
- 手持摄像机晃动感 / handheld camera shake
- 甩镜 / swish pan

**示例：**
```
水墨武侠动漫风格，15秒，9:16竖屏，孤寂压抑氛围

0-3秒：高空俯拍，大雪纷飞的草料场全景，镜头缓慢下降前推
3-6秒：中景推近，披蓑衣戴斗笠的男子（@图片3参考），手持长枪独立风雪中
6-9秒：面部特写，侧脸，眼神望向远方，眼中深藏落寞与不甘，呼出白气消散
9-12秒：镜头环绕缓慢旋转270度，展示孤独身影在茫茫雪地中
12-15秒：镜头拉远，背影（@图片2参考）消失在风雪中，水墨晕染渐起

【声音】凄清二胡独奏 + 寒风呼啸 + 雪地咯吱声
【参考】@图片1 首帧背景，@图片2 尾帧参考，@图片3 角色参考
```

---

### 🎬 巨日禄 / 可灵 Fusion（融生视频模式）

**最适合：** 有角色参考图、需要角色贯穿多集的项目

**重要：巨日禄 Excel 表格中，B列（分镜描述）使用叙事语言，不是AI提示词格式。**
**AI提示词的工作由平台内部完成。用户只需写导演语言。**

B列叙事描述示例：
```
李明走进昏暗的病房，停在床边，低头看着躺着的父亲，双手微微颤抖，嘴唇紧抿。
```

如需为巨日禄生成独立的Prompt格式（可选）：
```
[风格描述]，[时长]秒，[画幅]，[整体氛围]

场景：[具体场景，时间，天气，光线]（场景参考@S01-Wide）
角色：[固定描述词，与 C01 参考图一致]（参考@C01-F）

动作序列：
1. [起始动作] — [镜头运动]
2. [发展动作] — [镜头运动]
3. [高潮动作] — [镜头运动]
4. [收尾] — [镜头运动]

情绪氛围：[氛围关键词]
光线色调：[光线方向 + 色调]
防崩约束：人物结构正常，面部清晰不变形，动作连贯流畅，画面稳定不抖动

【声音】[配乐] + [音效] + [对白，如有]
【参考】@C01-F 主角正面参考，@C01-S 主角侧面，@S01-Wide 场景全景
```

---

### 🎬 即梦（字节跳动）

**中文提示词，理解中国短剧场景极佳。**

**提示词结构：**
```
[镜头类型]，[场景描述]，[人物描述+动作]，[情绪]，[画面风格]
```

**即梦特有效果词：**
- 电影感、高饱和度、低饱和度
- 胶片质感、油画风格、水墨风格
- 丁达尔光效、逆光、侧光打脸

**示例（古装修仙）：**
```
中景镜头，三千年前的古代集市，水墨风格，阳光明亮。一个穿白色修仙服的俊朗年轻男子站在街道中央，面若冠玉，神情温柔地俯视着一个满脸灰尘的小乞丐。仙侠古风，唯美光效。
```

---

### 🎬 可灵 Kling（标准模式）

**支持中英文，理解中国文化背景好。**

**提示词结构：**
```
[场景环境], [角色外貌+动作], [情绪氛围], [光线色调], [运镜方式]
```

**示例：**
```
昏暗的现代医院病房，蓝绿色冷光打在病床上，一个三四十岁的男子面色惨白地躺着，戴着氧气面罩，胸口微弱起伏。一位红色连衣裙的女性站在床边，嘴角冷笑，手持刚拔下的氧气管。阴冷压抑，充满张力。电影级构图，高对比度。缓慢推进镜头。
```

---

### 🎬 Midjourney（静止图 / 关键帧）

**只生成图片，画质极高。适合首尾帧生成、角色参考图生成。**

**提示词结构：**
```
[主体描述], [场景], [情绪氛围], [构图], [光线], [风格关键词] --ar 16:9 --style raw --v 6
```

**角色参考图生成（多角度保持一致）：**
```
正面：handsome Chinese man in his 30s, dark cotton jacket, bamboo hat, holding long spear, snow field background, ink wash painting style --ar 3:4
侧面：same Chinese man, 3/4 view, refined scholarly appearance, ink wash style --ar 3:4
背面：same Chinese man, back view, walking away into snowstorm --ar 9:16
```

**示例（水墨武将）：**
```
a Chinese warrior man in his 30s, weathered face, traditional cotton armor, bamboo hat, holding a long spear, standing alone in heavy snowfall, desolate landscape, Chinese ink wash painting style mixed with anime cel-shading, melancholic atmosphere, medium shot, cold grey tones, high detail --ar 9:16 --v 6
```

---

### 🎬 Runway Gen-3 / Sora（英文精品）

**高质量英文提示词，适合精品内容。**

**Sora 结构：**
```
A [duration]-second video of [subject+action], [scene], [camera movement], [lighting/mood], [visual style]
```

**示例：**
```
A 5-second video of a pale Chinese warrior man in his 30s lying in a dim prison cell, rising slowly and gripping his spear, anger replacing resignation in his eyes. Cold blue-grey prison lighting, extremely tense atmosphere, cinematic close-up to medium shot, ink wash animation style.
```

---

## 角色描述模板（中英对照）

用于在所有分镜中保持角色描述一致（即 Character Bible 的AI格式版本）：

```
[性别+年龄] Chinese [身份], [体型], [发型], [气质关键词], [服装描述]
```

**示例：**
- 林冲（古装）：`Chinese man in his late 30s, tall and lean, black hair in traditional bun, refined scholarly appearance, wearing a weathered dark cotton soldier's jacket, bamboo hat, carrying a long spear`
- 反派（现代）：`young Chinese woman in her mid-20s, beautiful and calculating appearance, wearing a red bodycon dress, cold smile`
