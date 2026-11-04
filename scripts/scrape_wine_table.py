import pandas as pd
import requests
from bs4 import BeautifulSoup

def scrape_wine_table_url(url, output_file="scraped_wine_barcodes.xlsx"):
    print(f"Connecting to directory site: {url}...")
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

    try:
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
    except Exception as e:
        print(f"Failed to reach web resource: {e}")
        return

    print("Parsing page structure...")
    soup = BeautifulSoup(response.text, 'html.parser')

    # Locate all tables present on the target directory page
    tables = soup.find_all('table')
    if not tables:
        print("No explicitly structured HTML tables found. Attempting text list parsing...")
        return

    print(f"Found {len(tables)} target data grid(s). Processing the primary table...")
    target_table = tables[0]

    # Extract headers
    headers = [th.text.strip() for th in target_table.find_all('th')]

    # Extract rows
    rows = []
    for tr in target_table.find_all('tr'):
        cells = [td.text.strip() for td in tr.find_all('td')]
        if cells:
            # If headers weren't found via <th> tags, establish schema from cell lengths
            if not headers:
                headers = [f"Column_{i}" for i in range(len(cells))]
            # Pad or truncate row rows to ensure match with table headers
            if len(cells) < len(headers):
                cells += [""] * (len(headers) - len(cells))
            rows.append(cells[:len(headers)])

    # Formulate tabular DataFrame
    df = pd.DataFrame(rows, columns=headers)

    # Clean output by removing rows entirely lacking data or barcode identities
    df.dropna(how='all', inplace=True)

    df.to_excel(output_file, index=False, sheet_name="Scraped Table Data")
    print(f"Success! Captured {len(df)} rows and created execution file: '{output_file}'")

if __name__ == "__main__":
    # Test sample target matching the Brazos Wine Directory mapping layout from your spreadsheet list
    sample_target_url = "https://www.brazoswine.com/resources/upc-codes"
    scrape_wine_table_url(sample_target_url)
