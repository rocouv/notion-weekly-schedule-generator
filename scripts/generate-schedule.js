const { Client } = require("@notionhq/client");

const notion = new Client({
    auth: process.env.NOTION_TOKEN,
});

const databaseId = process.env.NOTION_SCHEDULE_DATABASE_ID;
const weekStartInput = process.env.WEEK_START;

if (!process.env.NOTION_TOKEN) {
    throw new Error("Missing NOTION_TOKEN");
}

if (!databaseId) {
    throw new Error("Missing NOTION_SCHEDULE_DATABASE_ID");
}

if (!weekStartInput) {
    throw new Error("Missing WEEK_START. Use format YYYY-MM-DD.");
}

const DAY_OFFSETS = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
};

function addDays(dateString, days) {
    const date = new Date(`${dateString}T00:00:00`);
    date.setDate(date.getDate() + days);
    return date;
}

function toDateString(date) {
    return date.toISOString().slice(0, 10);
}

function buildDateTime(date, time) {
    return `${toDateString(date)}T${time}:00`;
}

function getTitle(page, propertyName) {
    const value = page.properties[propertyName]?.title ?? [];
    return value.map((item) => item.plain_text).join("");
}

function getSelect(page, propertyName) {
    return page.properties[propertyName]?.select?.name ?? null;
}

function getRichText(page, propertyName) {
    const value = page.properties[propertyName]?.rich_text ?? [];
    return value.map((item) => item.plain_text).join("");
}

function getCheckbox(page, propertyName) {
    return page.properties[propertyName]?.checkbox ?? false;
}

function getRelation(page, propertyName) {
    return page.properties[propertyName]?.relation ?? [];
}

function isFirstSunday(day, date) {
    return day === "Sunday" && date.getDate() <= 7;
}

function shouldCreateInstance(appliesOn, firstSunday) {
    if (appliesOn === "Every Week") return true;
    if (appliesOn === "First Week Only") return firstSunday;
    if (appliesOn === "Except First Week") return !firstSunday;

    return false;
}

async function getAllTemplates() {
    const templates = [];
    let cursor;

    do {
        const response = await notion.databases.query({
            database_id: databaseId,
            start_cursor: cursor,
            page_size: 100,
            filter: {
                and: [
                    {
                        property: "Schedule Type",
                        select: {
                            equals: "Template",
                        },
                    },
                    {
                        property: "Generation Status",
                        select: {
                            equals: "Template Ready",
                        },
                    },
                ],
            },
        });

        templates.push(...response.results);
        cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    return templates;
}

async function instanceExists(instanceKey) {
    const response = await notion.databases.query({
        database_id: databaseId,
        page_size: 1,
        filter: {
            property: "Instance Key",
            rich_text: {
                equals: instanceKey,
            },
        },
    });

    return response.results.length > 0;
}

async function createInstanceFromTemplate(template, weekStart) {
    const activity = getTitle(template, "Activity");
    const day = getSelect(template, "Day");
    const startTime = getRichText(template, "Start Time");
    const endTime = getRichText(template, "End Time");
    const blockType = getSelect(template, "Block Type");
    const appliesOn = getSelect(template, "Applies On");
    const fixed = getCheckbox(template, "Fixed");
    const flexible = getCheckbox(template, "Flexible");
    const area = getRelation(template, "Area");

    if (!activity || !day || !startTime || !endTime) {
        console.log(`Skipped incomplete template: ${template.id}`);
        return;
    }

    const dayOffset = DAY_OFFSETS[day];

    if (dayOffset === undefined) {
        console.log(`Skipped invalid day: ${activity} - ${day}`);
        return;
    }

    const eventDate = addDays(weekStart, dayOffset);
    const firstSunday = isFirstSunday(day, eventDate);

    if (!shouldCreateInstance(appliesOn, firstSunday)) {
        console.log(`Skipped by Applies On rule: ${activity} (${appliesOn})`);
        return;
    }

    const instanceKey = `${weekStart}_${day}_${activity}_${startTime}`;

    if (await instanceExists(instanceKey)) {
        console.log(`Skipped duplicate: ${instanceKey}`);
        return;
    }

    const startDateTime = buildDateTime(eventDate, startTime);
    const endDateTime = buildDateTime(eventDate, endTime);

    const properties = {
        Activity: {
            title: [
                {
                    text: {
                        content: activity,
                    },
                },
            ],
        },
        Date: {
            date: {
                start: startDateTime,
                end: endDateTime,
            },
        },
        Day: {
            select: {
                name: day,
            },
        },
        "Start Time": {
            rich_text: [
                {
                    text: {
                        content: startTime,
                    },
                },
            ],
        },
        "End Time": {
            rich_text: [
                {
                    text: {
                        content: endTime,
                    },
                },
            ],
        },
        "Schedule Type": {
            select: {
                name: "Instance",
            },
        },
        "Generation Status": {
            select: {
                name: "Generated",
            },
        },
        "Week Start": {
            date: {
                start: weekStart,
            },
        },
        "Instance Key": {
            rich_text: [
                {
                    text: {
                        content: instanceKey,
                    },
                },
            ],
        },
        Fixed: {
            checkbox: fixed,
        },
        Flexible: {
            checkbox: flexible,
        },
    };

    if (blockType) {
        properties["Block Type"] = {
            select: {
                name: blockType,
            },
        };
    }

    if (appliesOn) {
        properties["Applies On"] = {
            select: {
                name: appliesOn,
            },
        };
    }

    if (area.length > 0) {
        properties.Area = {
            relation: area.map((item) => ({
                id: item.id,
            })),
        };
    }

    await notion.pages.create({
        parent: {
            database_id: databaseId,
        },
        properties,
    });

    console.log(`Created: ${instanceKey}`);
}

async function main() {
    const weekStart = weekStartInput;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
        throw new Error("WEEK_START must use format YYYY-MM-DD");
    }

    const templates = await getAllTemplates();

    console.log(`Found ${templates.length} templates`);

    for (const template of templates) {
        await createInstanceFromTemplate(template, weekStart);
    }

    console.log("Schedule generation completed.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});