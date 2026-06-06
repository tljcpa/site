import { type CollectionEntry, getCollection } from "astro:content";

/** 取全部项目,生产环境过滤 draft。按 weight 降序、再按时间降序 */
export async function getAllProjects(): Promise<CollectionEntry<"project">[]> {
	const projects = await getCollection("project", ({ data }) => {
		return import.meta.env.PROD ? !data.draft : true;
	});
	return projects.sort((a, b) => {
		if (b.data.weight !== a.data.weight) {
			return b.data.weight - a.data.weight;
		}
		return b.data.publishDate.valueOf() - a.data.publishDate.valueOf();
	});
}
