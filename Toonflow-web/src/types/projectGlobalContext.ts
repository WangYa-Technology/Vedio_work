export type ProjectGlobalContextType = "plot" | "character" | "world";

export interface ProjectGlobalMaterial {
  content: string;
  sourceName: string;
  updatedAt?: number;
  canonStatus: "approved" | "proposed" | "unresolved";
}

export interface ProjectGlobalContext {
  plot: ProjectGlobalMaterial;
  character: ProjectGlobalMaterial;
  world: ProjectGlobalMaterial;
}

function createEmptyGlobalMaterial(): ProjectGlobalMaterial {
  return { content: "", sourceName: "", canonStatus: "approved" };
}

export function createEmptyProjectGlobalContext(): ProjectGlobalContext {
  return {
    plot: createEmptyGlobalMaterial(),
    character: createEmptyGlobalMaterial(),
    world: createEmptyGlobalMaterial(),
  };
}
