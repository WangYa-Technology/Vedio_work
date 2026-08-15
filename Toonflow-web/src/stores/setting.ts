export default defineStore(
  "setting",
  () => {
    const showSetting = ref(false);
    const canvasWheelEvent = ref("zoom");
    const activeMenu = ref("language");

    const baseUrl = ref<string>("http://127.0.0.1:10588/api");

    const otherSetting = ref({
      axiosTimeOut: 60 * 10 * 1000,
      assetsBatchGenereateSize: 5,
      chapterReg: "/第\\s*([0-9０-９零一二三四五六七八九十百千万]+)\\s*[章回节]\\s*([^\\n\\r]*)/g",
      interacting: true,
    });

    const themeSetting = ref({
      mode: "light" as "light" | "dark" | "auto",
      primaryColor: "#000",
    });

    const language = ref<string>("zh-CN");

    return { showSetting, baseUrl, otherSetting, themeSetting, language, activeMenu, canvasWheelEvent };
  },
  { persist: { pick: ["baseUrl", "otherSetting", "themeSetting", "language"] } },
);
