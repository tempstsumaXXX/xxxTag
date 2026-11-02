/**
 * 离线兜底词库：当后端接口不可用（例如本地静态预览）时，至少还有一份可用示例。
 */

export const SEED_LIBRARY = {
  name: "内置示例词库",
  version: 1,
  updated_at: "2025-01-01T00:00:00",
  groups: [
    {
      name: "质量与风格",
      subs: [
        {
          name: "质量词",
          tags: ["masterwork", "best_quality", "highres", "absurdres", "extremely_detailed", "detailed"],
        },
        {
          name: "画风",
          tags: ["anime_style", "illustration", "photorealistic", "sketch", "watercolor_(medium)", "oil_painting"],
        },
      ],
    },
    {
      name: "人物",
      subs: [
        {
          name: "人数构成",
          tags: ["1girl", "1boy", "2girls", "solo", "multiple_girls", "multiple_boys"],
        },
        {
          name: "发色",
          tags: ["red_hair", "blue_hair", "black_hair", "blonde_hair", "silver_hair", "pink_hair", "white_hair"],
        },
        {
          name: "发型",
          tags: ["long_hair", "short_hair", "twintails", "ponytail", "braid", "bob_cut", "hime_cut"],
        },
        {
          name: "眼睛",
          tags: ["blue_eyes", "red_eyes", "green_eyes", "yandere", "half-closed_eyes", "heterochromia"],
        },
      ],
    },
    {
      name: "动作姿势",
      subs: [
        {
          name: "基础姿势",
          tags: ["standing", "sitting", "lying", "walking", "running", "kneeling", "jumping"],
        },
        {
          name: "视线",
          tags: ["looking_at_viewer", "looking_away", "looking_back", "looking_up", "looking_down"],
        },
      ],
    },
    {
      name: "场景与氛围",
      subs: [
        {
          name: "自然环境",
          tags: ["forest", "ocean", "mountain", "sky", "night_sky", "cherry_blossoms", "flower_field"],
        },
        {
          name: "光影",
          tags: ["cinematic_lighting", "soft_lighting", "backlighting", "sunlight", "dramatic_shadows"],
        },
        {
          name: "镜头构图",
          tags: ["close-up", "full_body", "upper_body", "cowboy_shot", "from_below", "from_above", "depth_of_field"],
        },
      ],
    },
  ],
};
