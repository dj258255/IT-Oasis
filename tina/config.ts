import { defineConfig } from 'tinacms';
import categoryOptions from './category-options.json';

const branch = process.env.GITHUB_BRANCH || process.env.VERCEL_GIT_COMMIT_REF || process.env.HEAD || 'main';

export default defineConfig({
  branch,
  clientId: process.env.NEXT_PUBLIC_TINA_CLIENT_ID || '',
  token: process.env.TINA_TOKEN || '',

  build: {
    outputFolder: 'admin',
    publicFolder: 'public',
    basePath: 'IT-Oasis',
  },

  media: {
    tina: {
      mediaRoot: 'uploads',
      publicFolder: 'public',
    },
  },

  schema: {
    collections: [
      {
        name: 'siteSettings',
        label: 'Site Settings',
        path: 'src/data/site',
        format: 'json',
        ui: {
          allowedActions: { create: false, delete: false },
        },
        fields: [
          {
            type: 'string',
            name: 'name',
            label: 'Site Name',
            isTitle: true,
            required: true,
          },
          {
            type: 'string',
            name: 'description',
            label: 'Description (Korean)',
            ui: { component: 'textarea' },
          },
          {
            type: 'string',
            name: 'descriptionEn',
            label: 'Description (English)',
            ui: { component: 'textarea' },
          },
          {
            type: 'image',
            name: 'bannerImage',
            label: 'Banner Image',
            description: 'Main page hero banner image',
          },
          {
            type: 'image',
            name: 'authorImage',
            label: 'Author Profile Image',
            description: 'Profile photo shown on About page and author cards',
          },
          {
            type: 'string',
            name: 'authorBio',
            label: 'Author Bio (Korean)',
            ui: { component: 'textarea' },
          },
          {
            type: 'string',
            name: 'authorBioEn',
            label: 'Author Bio (English)',
            ui: { component: 'textarea' },
          },
          {
            type: 'string',
            name: 'githubUrl',
            label: 'GitHub URL',
          },
          {
            type: 'string',
            name: 'email',
            label: 'Email',
          },
          {
            type: 'object',
            name: 'socialLinks',
            label: 'Social Links',
            description: 'Add social/contact links shown on the profile card',
            list: true,
            fields: [
              {
                type: 'string',
                name: 'type',
                label: 'Type',
                required: true,
                options: [
                  { value: 'github', label: 'GitHub' },
                  { value: 'email', label: 'Email' },
                  { value: 'twitter', label: 'Twitter / X' },
                  { value: 'linkedin', label: 'LinkedIn' },
                  { value: 'instagram', label: 'Instagram' },
                  { value: 'youtube', label: 'YouTube' },
                  { value: 'discord', label: 'Discord' },
                  { value: 'blog', label: 'Blog / Website' },
                  { value: 'notion', label: 'Notion' },
                  { value: 'link', label: 'Custom Link' },
                ],
              },
              {
                type: 'string',
                name: 'url',
                label: 'URL or Value',
                required: true,
                description: 'Full URL (or email address for email type)',
              },
              {
                type: 'string',
                name: 'label',
                label: 'Label (optional)',
                description: 'Custom display label',
              },
            ],
          },
          {
            type: 'object',
            name: 'navItems',
            label: 'Navigation Items',
            description: 'Header navigation menu items. Add, remove, or reorder.',
            list: true,
            fields: [
              {
                type: 'string',
                name: 'label',
                label: 'Label (Korean)',
                required: true,
              },
              {
                type: 'string',
                name: 'labelEn',
                label: 'Label (English)',
                required: true,
              },
              {
                type: 'string',
                name: 'path',
                label: 'Page Path',
                required: true,
                description: 'URL path (e.g. /about, /blog, /projects, /tags)',
              },
              {
                type: 'string',
                name: 'icon',
                label: 'Icon',
                options: [
                  { value: 'person', label: 'Person' },
                  { value: 'grid', label: 'Grid' },
                  { value: 'newspaper', label: 'Newspaper' },
                  { value: 'tag', label: 'Tag' },
                  { value: 'home', label: 'Home' },
                  { value: 'book', label: 'Book' },
                  { value: 'code', label: 'Code' },
                  { value: 'heart', label: 'Heart' },
                  { value: 'star', label: 'Star' },
                  { value: 'globe', label: 'Globe' },
                  { value: 'folder', label: 'Folder' },
                  { value: 'chat', label: 'Chat' },
                ],
              },
            ],
          },
          {
            type: 'string',
            name: 'aboutSubtitleKo',
            label: 'About Page Subtitle (Korean)',
            ui: { component: 'textarea' },
          },
          {
            type: 'string',
            name: 'aboutSubtitleEn',
            label: 'About Page Subtitle (English)',
            ui: { component: 'textarea' },
          },
          {
            type: 'string',
            name: 'projectsSubtitleKo',
            label: 'Projects Page Subtitle (Korean)',
            ui: { component: 'textarea' },
          },
          {
            type: 'string',
            name: 'projectsSubtitleEn',
            label: 'Projects Page Subtitle (English)',
            ui: { component: 'textarea' },
          },
          {
            type: 'rich-text',
            name: 'aboutContentKo',
            label: 'About Page Content (Korean)',
            description: 'Rich text editor with image support. Shown on the About page.',
          },
          {
            type: 'rich-text',
            name: 'aboutContentEn',
            label: 'About Page Content (English)',
            description: 'Rich text editor with image support. Shown on the About page in EN mode.',
          },
        ],
      },
      {
        name: 'project',
        label: 'Projects',
        path: 'src/data/projects',
        format: 'json',
        fields: [
          {
            type: 'string',
            name: 'title',
            label: 'Title',
            isTitle: true,
            required: true,
          },
          {
            type: 'string',
            name: 'description',
            label: 'Description (Korean)',
            ui: { component: 'textarea' },
          },
          {
            type: 'string',
            name: 'descriptionEn',
            label: 'Description (English)',
            ui: { component: 'textarea' },
          },
          {
            type: 'image',
            name: 'image',
            label: 'Cover Image',
          },
          {
            type: 'string',
            name: 'tags',
            label: 'Tags',
            list: true,
          },
          {
            type: 'string',
            name: 'category',
            label: 'Category',
          },
          {
            type: 'datetime',
            name: 'date',
            label: 'Date',
          },
          {
            type: 'string',
            name: 'github',
            label: 'GitHub URL',
          },
          {
            type: 'string',
            name: 'website',
            label: 'Website URL',
          },
          {
            type: 'string',
            name: 'story',
            label: 'Story Link',
            description: 'Link to project story or related page.',
          },
          {
            type: 'number',
            name: 'order',
            label: 'Display Order',
            description: 'Lower number = shown first',
          },
        ],
      },
      {
        name: 'category',
        label: 'Categories',
        path: 'src/data/categories',
        format: 'json',
        fields: [
          {
            type: 'string',
            name: 'name',
            label: 'Category Name',
            isTitle: true,
            required: true,
          },
          {
            type: 'string',
            name: 'nameEn',
            label: 'Category Name (English)',
          },
          {
            type: 'string',
            name: 'icon',
            label: 'Icon',
            options: [
              { value: 'code', label: 'Code </>' },
              { value: 'heart', label: 'Heart' },
              { value: 'book', label: 'Book' },
              { value: 'server', label: 'Server' },
              { value: 'database', label: 'Database' },
              { value: 'globe', label: 'Globe' },
              { value: 'terminal', label: 'Terminal' },
              { value: 'cpu', label: 'CPU / Chip' },
              { value: 'palette', label: 'Palette / Design' },
              { value: 'camera', label: 'Camera' },
              { value: 'music', label: 'Music' },
              { value: 'gamepad', label: 'Gamepad' },
              { value: 'lightbulb', label: 'Lightbulb / Idea' },
              { value: 'rocket', label: 'Rocket' },
              { value: 'briefcase', label: 'Briefcase / Work' },
              { value: 'pencil', label: 'Pencil / Write' },
            ],
          },
          {
            type: 'object',
            name: 'subcategories',
            label: 'Subcategories',
            list: true,
            fields: [
              {
                type: 'string',
                name: 'name',
                label: 'Name',
                required: true,
              },
              {
                type: 'string',
                name: 'nameEn',
                label: 'Name (English)',
              },
            ],
          },
        ],
      },
      {
        name: 'blog',
        label: 'Blog Posts',
        path: 'src/content/blog',
        format: 'md',
        fields: [
          {
            type: 'string',
            name: 'title',
            label: 'Title',
            isTitle: true,
            required: true,
          },
          {
            type: 'string',
            name: 'titleEn',
            label: 'Title (English)',
          },
          {
            type: 'string',
            name: 'description',
            label: 'Description',
            required: true,
            ui: {
              component: 'textarea',
            },
          },
          {
            type: 'string',
            name: 'descriptionEn',
            label: 'Description (English)',
            ui: {
              component: 'textarea',
            },
          },
          {
            type: 'datetime',
            name: 'date',
            label: 'Date',
            required: true,
          },
          {
            type: 'string',
            name: 'tags',
            label: 'Tags',
            list: true,
          },
          {
            type: 'string',
            name: 'category',
            label: 'Category',
            options: categoryOptions,
          },
          {
            type: 'image',
            name: 'coverImage',
            label: 'Cover Image',
          },
          {
            type: 'boolean',
            name: 'draft',
            label: 'Draft',
          },
          {
            type: 'rich-text',
            name: 'body',
            label: 'Body',
            isBody: true,
          },
        ],
      },
    ],
  },
});
