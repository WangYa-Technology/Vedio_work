<template>
  <div class="about">
    <t-card bordered :style="{ width: '100%' }" class="logoCard">
      <div class="f">
        <div class="logo">🍊</div>
        <div class="appName">
          <div class="name">漫橙映画</div>
          <div class="data">{{ $t("settings.about.slogan") }}</div>
          <div class="version">
            <t-tag theme="primary" shape="round" size="small" style="padding: 10px">v{{ version }}</t-tag>
          </div>
        </div>
      </div>
    </t-card>

    <div class="codeRepository">
      <span>{{ $t("settings.about.codeRepository") }}</span>
      <t-card bordered :style="{ width: '100%' }" class="logoCard">
        <div class="ac jb repository" @click="openLink('https://github.com/HBAI-Ltd/Toonflow-app')">
          <div class="f">
            <div class="repositoryIcon">
              <i-github theme="outline" size="22" class="c" />
            </div>
            <div class="repositoryText">
              <div class="repositoryName">{{ $t("settings.about.githubRepo") }}</div>
              <div class="repositoryUrl">https://github.com/HBAI-Ltd/Toonflow-app</div>
            </div>
          </div>
          <i-right theme="outline" size="18" />
        </div>
        <t-divider />
        <div class="ac jb repository" @click="openLink('https://gitee.com/HBAI-Ltd/Toonflow-app')">
          <div class="f">
            <div class="repositoryIcon">
              <i-code theme="outline" size="20" class="c" />
            </div>
            <div class="repositoryText">
              <div class="repositoryName">{{ $t("settings.about.giteeRepo") }}</div>
              <div class="repositoryUrl">https://gitee.com/HBAI-Ltd/Toonflow-app</div>
            </div>
          </div>
          <i-right theme="outline" size="18" />
        </div>
      </t-card>
    </div>

    <div class="license">
      <span>{{ $t("settings.about.license") }}</span>
      <t-card bordered :style="{ width: '100%' }" class="logoCard">
        <div class="ac jb">
          <div class="f">
            <div class="repositoryIcon">
              <i-notes theme="outline" size="20" class="c" />
            </div>
            <div class="repositoryText">
              <div class="repositoryName">Apache-2.0 License</div>
              <div class="repositoryUrl">{{ $t("settings.about.licenseDesc") }}</div>
            </div>
          </div>
          <i-right theme="outline" size="18" />
        </div>
      </t-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import store from "@/stores/index";

const { version } = storeToRefs(store());

function openLink(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

onMounted(async () => {
  const { data } = await axios.get("/other/getVersion");
  version.value = data;
});
</script>

<style lang="scss" scoped>
.about {
  .logoCard {
    margin-top: 5px;
    padding: 15px;
  }

  .logo {
    width: 72px;
    height: 72px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border-radius: 16px;
    background: linear-gradient(135deg, #ff9a56 0%, #ff6b35 100%);
    font-size: 48px;
  }

  .appName {
    margin-left: 20px;

    .name {
      font-size: 20px;
      font-weight: 900;
    }

    .data {
      margin-top: 5px;
      color: #666;
      font-size: 12px;
    }

    .version {
      margin-top: 5px;
    }
  }

  > div > span {
    font-size: 12px;
    font-weight: 500;
  }

  .codeRepository,
  .license {
    margin-top: 15px;
  }

  .repository {
    cursor: pointer;
  }

  .repositoryIcon {
    width: 50px;
    height: 50px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border-radius: 8px;
    background-color: #ececec;
  }

  .repositoryText {
    min-width: 0;
    margin-left: 15px;
  }

  .repositoryName {
    font-size: 15px;
    font-weight: 900;
  }

  .repositoryUrl {
    overflow-wrap: anywhere;
    color: #666;
    font-size: 12px;
  }
}
</style>
