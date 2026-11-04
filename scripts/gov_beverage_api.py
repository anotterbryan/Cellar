import pandas as pd
import requests
import time

def fetch_government_beverage_api(output_file="gov_api_wine_records.xlsx"):
    # Using open-records Socrata catalog standard endpoint which maps public government open lists
    base_url = "http://api.us.socrata.com/api/catalog/v1"

    # Setting search parameters specifically targeting public compliance wine/alcohol datasets
    params = {
        "only": "datasets",
        "q": "wine inventory retail pricing",
        "limit": 50
    }

    print("Initiating connection handshake with the Government open data API portal...")
    try:
        response = requests.get(base_url, params=params, timeout=15)
        response.raise_for_status()
        api_data = response.json()
    except Exception as e:
        print(f"API Connection Failed: {e}")
        return

    results = api_data.get("results", [])
    if not results:
        print("API successfully responded, but no registry records matched query search strings.")
        return

    print(f"Payload received! Extracting schema parameters for {len(results)} distinct tracking registries...")

    flattened_records = []
    for item in results:
        # Access nested JSON structures cleanly
        resource_info = item.get("resource", {})
        metadata_info = item.get("metadata", {})

        record = {
            "Registry_ID": resource_info.get("id", ""),
            "Dataset_Title": resource_info.get("name", ""),
            "Description": resource_info.get("description", ""),
            "Parent_Agency": metadata_info.get("domain", ""),
            "Direct_Data_Link": resource_info.get("permalink", ""),
            "Last_Updated": resource_info.get("updatedAt", "")
        }
        flattened_records.append(record)

    # Convert JSON array to table formatting
    df = pd.DataFrame(flattened_records)
    df.to_excel(output_file, index=False, sheet_name="Government Registry Links")
    print(f"API query sequence fully resolved. Results saved to local asset: '{output_file}'")

if __name__ == "__main__":
    fetch_government_beverage_api()
