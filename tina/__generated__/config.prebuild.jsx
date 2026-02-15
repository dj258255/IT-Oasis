// tina/config.ts
import { defineConfig } from "tinacms";
import fs from "node:fs";
import path from "node:path";
var branch = process.env.GITHUB_BRANCH || process.env.VERCEL_GIT_COMMIT_REF || process.env.HEAD || "main";
var catDir = path.join(process.cwd(), "src/data/categories");
var categoryOptions = [];
try {
  const files = fs.readdirSync(catDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(catDir, file), "utf-8"));
    categoryOptions.push(data.name);
    for (const sub of data.subcategories || []) {
      categoryOptions.push(`${data.name}/${sub.name}`);
    }
  }
} catch {
}
var config_default = defineConfig({
  branch,
  clientId: process.env.NEXT_PUBLIC_TINA_CLIENT_ID || "",
  token: process.env.TINA_TOKEN || "",
  build: {
    outputFolder: "admin",
    publicFolder: "public",
    basePath: "IT-Oasis"
  },
  media: {
    store: {
      mediaRoot: "uploads",
      publicFolder: "public"
    }
  },
  schema: {
    collections: [
      {
        name: "siteSettings",
        label: "Site Settings",
        path: "src/data/site",
        format: "json",
        ui: {
          allowedActions: { create: false, delete: false }
        },
        fields: [
          {
            type: "string",
            name: "name",
            label: "Site Name",
            isTitle: true,
            required: true
          },
          {
            type: "string",
            name: "description",
            label: "Description (Korean)",
            ui: { component: "textarea" }
          },
          {
            type: "string",
            name: "descriptionEn",
            label: "Description (English)",
            ui: { component: "textarea" }
          },
          {
            type: "string",
            name: "status",
            label: "Status",
            options: ["Active", "Away", "Inactive"]
          },
          {
            type: "image",
            name: "bannerImage",
            label: "Banner Image",
            description: "Main page hero banner image"
          },
          {
            type: "string",
            name: "authorBio",
            label: "Author Bio (Korean)",
            ui: { component: "textarea" }
          },
          {
            type: "string",
            name: "authorBioEn",
            label: "Author Bio (English)",
            ui: { component: "textarea" }
          },
          {
            type: "string",
            name: "githubUrl",
            label: "GitHub URL"
          },
          {
            type: "string",
            name: "email",
            label: "Email"
          }
        ]
      },
      {
        name: "category",
        label: "Categories",
        path: "src/data/categories",
        format: "json",
        fields: [
          {
            type: "string",
            name: "name",
            label: "Category Name",
            isTitle: true,
            required: true
          },
          {
            type: "string",
            name: "nameEn",
            label: "Category Name (English)"
          },
          {
            type: "string",
            name: "icon",
            label: "Icon",
            options: [
              { value: "code", label: "Code </>" },
              { value: "heart", label: "Heart" },
              { value: "book", label: "Book" },
              { value: "server", label: "Server" },
              { value: "database", label: "Database" },
              { value: "globe", label: "Globe" },
              { value: "terminal", label: "Terminal" },
              { value: "cpu", label: "CPU / Chip" },
              { value: "palette", label: "Palette / Design" },
              { value: "camera", label: "Camera" },
              { value: "music", label: "Music" },
              { value: "gamepad", label: "Gamepad" },
              { value: "lightbulb", label: "Lightbulb / Idea" },
              { value: "rocket", label: "Rocket" },
              { value: "briefcase", label: "Briefcase / Work" },
              { value: "pencil", label: "Pencil / Write" }
            ]
          },
          {
            type: "object",
            name: "subcategories",
            label: "Subcategories",
            list: true,
            fields: [
              {
                type: "string",
                name: "name",
                label: "Name",
                required: true
              },
              {
                type: "string",
                name: "nameEn",
                label: "Name (English)"
              }
            ]
          }
        ]
      },
      {
        name: "blog",
        label: "Blog Posts",
        path: "src/content/blog",
        format: "md",
        fields: [
          {
            type: "string",
            name: "title",
            label: "Title",
            isTitle: true,
            required: true
          },
          {
            type: "string",
            name: "titleEn",
            label: "Title (English)"
          },
          {
            type: "string",
            name: "description",
            label: "Description",
            required: true,
            ui: {
              component: "textarea"
            }
          },
          {
            type: "string",
            name: "descriptionEn",
            label: "Description (English)",
            ui: {
              component: "textarea"
            }
          },
          {
            type: "datetime",
            name: "date",
            label: "Date",
            required: true
          },
          {
            type: "string",
            name: "tags",
            label: "Tags",
            list: true
          },
          {
            type: "string",
            name: "category",
            label: "Category",
            options: categoryOptions
          },
          {
            type: "image",
            name: "coverImage",
            label: "Cover Image"
          },
          {
            type: "boolean",
            name: "draft",
            label: "Draft"
          },
          {
            type: "rich-text",
            name: "body",
            label: "Body",
            isBody: true
          }
        ]
      }
    ]
  }
});
export {
  config_default as default
};
